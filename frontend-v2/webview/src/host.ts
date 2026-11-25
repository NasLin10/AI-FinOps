import type { ToHost, ToWebview } from './protocol';

/**
 * Связь с extension host (Cursor / VS Code). Именно он держит токен, ходит на backend,
 * пишет в буфер обмена и сохраняет файлы: интерфейс панели сам в сеть не выходит.
 */
export interface Host {
  send(msg: ToHost): void;
  onMessage(cb: (msg: ToWebview) => void): () => void;
}

interface VsCodeApi {
  postMessage(msg: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

/** null — страница открыта вне Cursor (расширение не загружено). */
export function createHost(): Host | null {
  if (typeof acquireVsCodeApi !== 'function') return null;
  const api = acquireVsCodeApi();
  return {
    send: (msg) => api.postMessage(msg),
    onMessage(cb) {
      const handler = (e: MessageEvent) => cb(e.data as ToWebview);
      window.addEventListener('message', handler);
      return () => window.removeEventListener('message', handler);
    },
  };
}
