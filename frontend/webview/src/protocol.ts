// Протокол сообщений между Webview и extension host.
// Только типы: файл импортируется и расширением, и интерфейсом.

export type Tier = 'economy' | 'balanced' | 'premium';

export interface ModelOption {
  id: string;
  displayName: string;
  tier: Tier;
  notes?: string;
}

export interface HostConfig {
  apiBaseUrl: string;
  demoMode: boolean;
  hasToken: boolean;
  timeoutSec: number;
  models: ModelOption[];
  runtime: 'vscode' | 'browser';
}

/** Результат сетевого вызова, как его видит webview (без секретов). */
export type RawResult =
  | { kind: 'http'; status: number; retryAfter?: string; body: unknown }
  | { kind: 'network'; message: string }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }
  | { kind: 'blocked'; message: string };

export type HostCommand = 'setToken' | 'clearToken' | 'openSettings' | 'openPanel' | 'resetData';

export type ToHost =
  | { type: 'ready' }
  | { type: 'plan.request'; requestId: string; payload: unknown }
  | { type: 'plan.cancel'; requestId: string }
  | { type: 'clipboard.write'; text: string }
  | { type: 'file.export'; suggestedName: string; content: string; label: string }
  | { type: 'state.save'; state: unknown }
  | { type: 'command'; name: HostCommand };

export type ToWebview =
  | { type: 'init'; config: HostConfig; state: unknown }
  | { type: 'config'; config: HostConfig }
  | { type: 'plan.response'; requestId: string; result: RawResult }
  | { type: 'toast'; text: string; level: 'info' | 'error' }
  | { type: 'reset' };
