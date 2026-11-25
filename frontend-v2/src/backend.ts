// Сетевой слой для backend декомпозитора. Не зависит от vscode, поэтому проверяется
// настоящими HTTP-запросами в tests/contract.test.ts.
import type { BackendStatus, RawResult } from '../webview/src/protocol';

export const MAX_REQUEST_BYTES = 256 * 1024;

export type BaseUrl = { ok: true; base: string } | { ok: false; message: string };

/** Проверяет адрес backend и приводит его к виду без хвостового слэша (путь-префикс сохраняется). */
export function normalizeBaseUrl(raw: string): BaseUrl {
  const text = raw.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, message: `Некорректный адрес backend: «${text || 'пусто'}». Проверьте настройку decomposer.apiBaseUrl.` };
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    return { ok: false, message: 'Адрес backend должен начинаться с https://. Простой http:// допустим только для localhost.' };
  }
  return { ok: true, base: `${url.origin}${url.pathname.replace(/\/+$/, '')}` };
}

const hasFetch = () => typeof fetch === 'function';
const NO_FETCH = 'В этой версии Cursor нет встроенного fetch. Обновите Cursor до актуальной версии.';

interface Call {
  base: string;
  path: string;
  method: 'GET' | 'POST';
  token?: string;
  body?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

async function call(c: Call): Promise<RawResult> {
  if (!hasFetch()) return { kind: 'blocked', message: NO_FETCH };
  const ctrl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctrl.abort();
  if (c.signal?.aborted) return { kind: 'cancelled' };
  c.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, c.timeoutMs);
  try {
    const res = await fetch(c.base + c.path, {
      method: c.method,
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json',
        ...(c.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(c.token ? { Authorization: `Bearer ${c.token}` } : {}),
      },
      body: c.body,
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text.trim() ? JSON.parse(text) : null;
    } catch {
      body = { unparsable: true, snippet: text.slice(0, 200) };
    }
    return { kind: 'http', status: res.status, retryAfter: res.headers.get('retry-after') ?? undefined, body };
  } catch (e) {
    if (timedOut) return { kind: 'timeout' };
    if (c.signal?.aborted || ctrl.signal.aborted) return { kind: 'cancelled' };
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : '';
    const msg = e instanceof Error ? e.message : String(e);
    return { kind: 'network', message: cause && cause !== msg ? `${msg} (${cause})` : msg };
  } finally {
    clearTimeout(timer);
    c.signal?.removeEventListener('abort', onAbort);
  }
}

export function postPlan(opts: {
  base: string;
  token?: string;
  body: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<RawResult> {
  if (Buffer.byteLength(opts.body, 'utf8') > MAX_REQUEST_BYTES) {
    return Promise.resolve({ kind: 'blocked', message: 'Запрос больше 256 КиБ. Сократите текст задачи или фрагмент кода.' });
  }
  return call({ base: opts.base, path: '/v1/plans', method: 'POST', token: opts.token, body: opts.body, timeoutMs: opts.timeoutMs, signal: opts.signal });
}

/** Проверяет по очереди: адрес → доступность (/health) → токен (/v1/capabilities). */
export async function checkBackend(rawBase: string, token: string | undefined, timeoutMs = 8000): Promise<BackendStatus> {
  const base = normalizeBaseUrl(rawBase);
  if (!base.ok) return { state: 'bad-url', message: base.message };

  const health = await call({ base: base.base, path: '/health', method: 'GET', timeoutMs });
  if (health.kind === 'blocked') return { state: 'down', message: health.message };
  if (health.kind === 'timeout') return { state: 'down', message: 'Backend не ответил за 8 секунд.' };
  if (health.kind === 'network') return { state: 'down', message: `Нет связи с ${base.base}. ${health.message}` };
  if (health.kind === 'http' && (health.status < 200 || health.status >= 300)) {
    return { state: 'down', message: `По адресу ${base.base} отвечает не backend декомпозитора (HTTP ${health.status}). Проверьте адрес и порт.` };
  }

  if (!token) return { state: 'no-token' };

  const caps = await call({ base: base.base, path: '/v1/capabilities', method: 'GET', token, timeoutMs });
  if (caps.kind !== 'http') return { state: 'down', message: 'Backend перестал отвечать во время проверки.' };
  if (caps.status === 401 || caps.status === 403) return { state: 'auth' };
  if (caps.status < 200 || caps.status >= 300) return { state: 'down', message: `Backend вернул HTTP ${caps.status} на проверку возможностей.` };
  const b = caps.body as { policyVersion?: unknown; limits?: { requestBytes?: unknown } } | null;
  return {
    state: 'ok',
    policyVersion: typeof b?.policyVersion === 'string' ? b.policyVersion : undefined,
    requestBytes: typeof b?.limits?.requestBytes === 'number' ? b.limits.requestBytes : undefined,
  };
}
