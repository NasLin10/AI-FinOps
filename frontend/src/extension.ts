import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { HostConfig, ModelOption, RawResult, ToHost, ToWebview } from '../webview/src/protocol';

const STATE_KEY = 'decomposer.state.v1';
const TOKEN_KEY = 'decomposer.backendToken';
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_STATE_BYTES = 4 * 1024 * 1024;

const DEFAULT_MODELS: ModelOption[] = [
  { id: 'model-economy', displayName: 'Экономичная (быстрая)', tier: 'economy' },
  { id: 'model-balanced', displayName: 'Сбалансированная', tier: 'balanced' },
  { id: 'model-premium', displayName: 'Премиальная (reasoning: high)', tier: 'premium' },
];

// ---------- конфигурация ----------

async function readConfig(ctx: vscode.ExtensionContext): Promise<HostConfig> {
  const cfg = vscode.workspace.getConfiguration('decomposer');
  const rawModels = cfg.get<unknown>('models');
  const models = Array.isArray(rawModels) ? rawModels.filter(isModelOption) : DEFAULT_MODELS;
  return {
    apiBaseUrl: String(cfg.get('apiBaseUrl') ?? ''),
    demoMode: Boolean(cfg.get('demoMode')),
    timeoutSec: Number(cfg.get('requestTimeoutSec') ?? 100),
    models: models.length ? models : DEFAULT_MODELS,
    hasToken: Boolean(await ctx.secrets.get(TOKEN_KEY)),
    runtime: 'vscode',
  };
}

function isModelOption(m: unknown): m is ModelOption {
  if (!m || typeof m !== 'object') return false;
  const o = m as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    o.id.length > 0 &&
    typeof o.displayName === 'string' &&
    (o.tier === 'economy' || o.tier === 'balanced' || o.tier === 'premium') &&
    (o.notes === undefined || typeof o.notes === 'string')
  );
}

// ---------- валидация сообщений от webview ----------

function parseMessage(raw: unknown): ToHost | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'ready':
      return { type: 'ready' };
    case 'plan.request':
      return typeof m.requestId === 'string' && m.payload !== undefined
        ? { type: 'plan.request', requestId: m.requestId, payload: m.payload }
        : null;
    case 'plan.cancel':
      return typeof m.requestId === 'string' ? { type: 'plan.cancel', requestId: m.requestId } : null;
    case 'clipboard.write':
      return typeof m.text === 'string' && m.text.length < 2_000_000
        ? { type: 'clipboard.write', text: m.text }
        : null;
    case 'file.export':
      return typeof m.suggestedName === 'string' &&
        typeof m.content === 'string' &&
        typeof m.label === 'string' &&
        m.content.length < 8_000_000
        ? { type: 'file.export', suggestedName: m.suggestedName, content: m.content, label: m.label }
        : null;
    case 'state.save':
      return 'state' in m ? { type: 'state.save', state: m.state } : null;
    case 'command':
      return ['setToken', 'clearToken', 'openSettings', 'openPanel', 'resetData'].includes(String(m.name))
        ? { type: 'command', name: m.name as 'setToken' }
        : null;
    default:
      return null;
  }
}

// ---------- сетевой вызов backend (ключи и токен остаются здесь) ----------

function checkBaseUrl(raw: string): { ok: true; url: URL } | { ok: false; message: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, message: `Некорректный адрес backend: «${raw}». Проверьте настройку decomposer.apiBaseUrl.` };
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) return { ok: true, url };
  return {
    ok: false,
    message: 'Адрес backend должен начинаться с https://. Простой http:// допустим только для localhost.',
  };
}

class PlanClient {
  private readonly inflight = new Map<string, AbortController>();

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  cancel(requestId: string): void {
    this.inflight.get(requestId)?.abort('cancelled');
  }

  async send(requestId: string, payload: unknown): Promise<RawResult> {
    const cfg = await readConfig(this.ctx);
    const base = checkBaseUrl(cfg.apiBaseUrl);
    if (!base.ok) return { kind: 'blocked', message: base.message };

    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
      return { kind: 'blocked', message: 'Запрос больше 256 KiB. Сократите текст задачи или фрагмент кода.' };
    }

    const token = await this.ctx.secrets.get(TOKEN_KEY);
    const ctrl = new AbortController();
    this.inflight.set(requestId, ctrl);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort('timeout');
    }, Math.max(10, cfg.timeoutSec) * 1000);

    try {
      const res = await fetch(new URL('/v1/plans', base.url), {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body,
      });
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = { unparsable: true, snippet: text.slice(0, 200) };
      }
      return {
        kind: 'http',
        status: res.status,
        retryAfter: res.headers.get('retry-after') ?? undefined,
        body: parsed,
      };
    } catch (e) {
      if (timedOut) return { kind: 'timeout' };
      if (ctrl.signal.aborted) return { kind: 'cancelled' };
      return { kind: 'network', message: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
      this.inflight.delete(requestId);
    }
  }
}

// ---------- webview ----------

class WebviewHost {
  private readonly webviews = new Set<vscode.Webview>();
  private readonly client: PlanClient;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.client = new PlanClient(ctx);
  }

  attach(webview: vscode.Webview, disposables: vscode.Disposable[]): void {
    const dist = vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview');
    webview.options = { enableScripts: true, localResourceRoots: [dist] };
    webview.html = this.html(webview, dist);
    this.webviews.add(webview);
    disposables.push(
      webview.onDidReceiveMessage((raw) => {
        const msg = parseMessage(raw);
        if (msg) void this.handle(webview, msg);
      }),
      { dispose: () => this.webviews.delete(webview) },
    );
  }

  post(webview: vscode.Webview, msg: ToWebview): void {
    void webview.postMessage(msg);
  }

  broadcast(msg: ToWebview): void {
    for (const w of this.webviews) this.post(w, msg);
  }

  async pushConfig(): Promise<void> {
    this.broadcast({ type: 'config', config: await readConfig(this.ctx) });
  }

  private async handle(webview: vscode.Webview, msg: ToHost): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.post(webview, {
          type: 'init',
          config: await readConfig(this.ctx),
          state: this.ctx.globalState.get(STATE_KEY) ?? null,
        });
        return;
      case 'plan.request': {
        const result = await this.client.send(msg.requestId, msg.payload);
        this.post(webview, { type: 'plan.response', requestId: msg.requestId, result });
        return;
      }
      case 'plan.cancel':
        this.client.cancel(msg.requestId);
        return;
      case 'clipboard.write':
        await vscode.env.clipboard.writeText(msg.text);
        return;
      case 'file.export':
        await this.exportFile(webview, msg.suggestedName, msg.content, msg.label);
        return;
      case 'state.save':
        if (JSON.stringify(msg.state ?? null).length < MAX_STATE_BYTES) {
          await this.ctx.globalState.update(STATE_KEY, msg.state);
        }
        return;
      case 'command':
        await this.runCommand(msg.name);
        return;
    }
  }

  private async exportFile(webview: vscode.Webview, name: string, content: string, label: string): Promise<void> {
    const safeName = name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'plan.md';
    const root = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(process.env.HOME ?? '.');
    // Системный диалог сохранения сам спрашивает подтверждение перезаписи.
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(root, safeName),
      saveLabel: 'Сохранить',
      title: label,
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
    this.post(webview, { type: 'toast', text: `Сохранено: ${target.fsPath}`, level: 'info' });
  }

  private async runCommand(name: string): Promise<void> {
    const map: Record<string, string> = {
      setToken: 'decomposer.setToken',
      clearToken: 'decomposer.clearToken',
      openPanel: 'decomposer.openPanel',
      resetData: 'decomposer.resetData',
    };
    if (name === 'openSettings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'decomposer');
      return;
    }
    if (map[name]) await vscode.commands.executeCommand(map[name]);
  }

  private html(webview: vscode.Webview, dist: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'assets', 'index.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'assets', 'index.css'));
    // connect-src отсутствует намеренно: webview не ходит в сеть, все запросы делает extension host.
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
    ].join('; ');
    return `<!doctype html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${style}" />
<title>Декомпозитор задач</title>
</head>
<body>
<div id="root"></div>
<script type="module" nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

class SidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'decomposer.sidebar';
  constructor(private readonly host: WebviewHost) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const disposables: vscode.Disposable[] = [];
    this.host.attach(view.webview, disposables);
    view.onDidDispose(() => disposables.forEach((d) => d.dispose()));
  }
}

// ---------- активация ----------

export function activate(ctx: vscode.ExtensionContext): void {
  const host = new WebviewHost(ctx);
  let panel: vscode.WebviewPanel | undefined;

  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, new SidebarProvider(host), {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.commands.registerCommand('decomposer.openPanel', () => {
      if (panel) {
        panel.reveal();
        return;
      }
      panel = vscode.window.createWebviewPanel(
        'decomposer.panel',
        'Декомпозитор задач',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      const disposables: vscode.Disposable[] = [];
      host.attach(panel.webview, disposables);
      panel.onDidDispose(() => {
        disposables.forEach((d) => d.dispose());
        panel = undefined;
      });
    }),

    vscode.commands.registerCommand('decomposer.setToken', async () => {
      const token = await vscode.window.showInputBox({
        title: 'Токен доступа к backend декомпозитора',
        prompt: 'Хранится в SecretStorage и не передаётся в интерфейс панели.',
        password: true,
        ignoreFocusOut: true,
      });
      if (token === undefined) return;
      if (token.trim() === '') {
        await ctx.secrets.delete(TOKEN_KEY);
      } else {
        await ctx.secrets.store(TOKEN_KEY, token.trim());
      }
      await host.pushConfig();
    }),

    vscode.commands.registerCommand('decomposer.clearToken', async () => {
      await ctx.secrets.delete(TOKEN_KEY);
      await host.pushConfig();
      void vscode.window.showInformationMessage('Токен доступа удалён.');
    }),

    vscode.commands.registerCommand('decomposer.resetData', async () => {
      const answer = await vscode.window.showWarningMessage(
        'Удалить сохранённую задачу, план и настройки панели?',
        { modal: true },
        'Удалить',
      );
      if (answer !== 'Удалить') return;
      await ctx.globalState.update(STATE_KEY, undefined);
      host.broadcast({ type: 'reset' });
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('decomposer')) void host.pushConfig();
    }),
    ctx.secrets.onDidChange((e) => {
      if (e.key === TOKEN_KEY) void host.pushConfig();
    }),
  );
}

export function deactivate(): void {}
