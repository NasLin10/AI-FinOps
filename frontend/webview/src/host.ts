import type { HostConfig, ModelOption, RawResult, ToHost, ToWebview } from './protocol';

/**
 * Единый транспорт для интерфейса.
 * - В расширении (Cursor / VS Code) сообщения уходят в extension host: он держит токен,
 *   делает сетевые запросы, пишет файлы и буфер обмена.
 * - В браузере (npm run dev:web) эти же сообщения обрабатывает эмуляция ниже, поэтому
 *   интерфейс можно разрабатывать и показывать без установки расширения.
 */
export interface Host {
  runtime: 'vscode' | 'browser';
  send(msg: ToHost): void;
  onMessage(cb: (msg: ToWebview) => void): () => void;
}

export const DEFAULT_MODELS: ModelOption[] = [
  { id: 'model-economy', displayName: 'Экономичная (быстрая)', tier: 'economy', notes: 'Дешёвая и быстрая, слабый reasoning. Для небольших, чётко очерченных правок.' },
  { id: 'model-balanced', displayName: 'Сбалансированная', tier: 'balanced', notes: 'Средняя цена и качество, умеренный reasoning. Для типовых задач в 1–2 модулях.' },
  { id: 'model-premium', displayName: 'Премиальная (reasoning: high)', tier: 'premium', notes: 'Дорогая, сильный reasoning. Для архитектуры, интеграции, рискованных мест.' },
];

interface VsCodeApi {
  postMessage(msg: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

function createVsCodeHost(): Host {
  const api = acquireVsCodeApi();
  return {
    runtime: 'vscode',
    send: (msg) => api.postMessage(msg),
    onMessage(cb) {
      const handler = (e: MessageEvent) => cb(e.data as ToWebview);
      window.addEventListener('message', handler);
      return () => window.removeEventListener('message', handler);
    },
  };
}

// ---------- эмуляция host для браузера ----------

const LS_KEY = 'decomposer.state.v1';

function createBrowserHost(): Host {
  const listeners = new Set<(m: ToWebview) => void>();
  const inflight = new Map<string, AbortController>();
  const emit = (m: ToWebview) => setTimeout(() => listeners.forEach((l) => l(m)), 0);

  const env = import.meta.env as Record<string, string | undefined>;
  const config: HostConfig = {
    apiBaseUrl: env.VITE_API_BASE_URL ?? 'http://localhost:8787',
    demoMode: (env.VITE_DEMO_MODE ?? 'true') !== 'false',
    hasToken: false,
    timeoutSec: Number(env.VITE_REQUEST_TIMEOUT_SEC ?? 100),
    models: DEFAULT_MODELS,
    runtime: 'browser',
  };

  async function planRequest(requestId: string, payload: unknown): Promise<RawResult> {
    let url: URL;
    try {
      url = new URL('/v1/plans', config.apiBaseUrl);
    } catch {
      return { kind: 'blocked', message: `Некорректный адрес backend: «${config.apiBaseUrl}».` };
    }
    const ctrl = new AbortController();
    inflight.set(requestId, ctrl);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, config.timeoutSec * 1000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = { unparsable: true };
      }
      return { kind: 'http', status: res.status, retryAfter: res.headers.get('retry-after') ?? undefined, body };
    } catch (e) {
      if (timedOut) return { kind: 'timeout' };
      if (ctrl.signal.aborted) return { kind: 'cancelled' };
      return { kind: 'network', message: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
      inflight.delete(requestId);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  }

  function download(name: string, content: string) {
    const type = name.endsWith('.json') ? 'application/json' : 'text/markdown';
    const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return {
    runtime: 'browser',
    onMessage(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    send(msg) {
      switch (msg.type) {
        case 'ready': {
          let state: unknown = null;
          try {
            state = JSON.parse(localStorage.getItem(LS_KEY) ?? 'null');
          } catch {
            state = null;
          }
          emit({ type: 'init', config, state });
          return;
        }
        case 'state.save':
          try {
            localStorage.setItem(LS_KEY, JSON.stringify(msg.state));
          } catch {
            /* хранилище недоступно — работаем без сохранения */
          }
          return;
        case 'plan.request':
          void planRequest(msg.requestId, msg.payload).then((result) =>
            emit({ type: 'plan.response', requestId: msg.requestId, result }),
          );
          return;
        case 'plan.cancel':
          inflight.get(msg.requestId)?.abort();
          return;
        case 'clipboard.write':
          void copy(msg.text);
          return;
        case 'file.export':
          download(msg.suggestedName, msg.content);
          emit({ type: 'toast', text: `Файл «${msg.suggestedName}» скачан`, level: 'info' });
          return;
        case 'command':
          if (msg.name === 'resetData') {
            try {
              localStorage.removeItem(LS_KEY);
            } catch {
              /* ignore */
            }
            emit({ type: 'reset' });
          } else {
            emit({ type: 'toast', text: 'Эта команда доступна только внутри расширения Cursor.', level: 'info' });
          }
          return;
      }
    },
  };
}

export function createHost(): Host {
  return typeof acquireVsCodeApi === 'function' ? createVsCodeHost() : createBrowserHost();
}
