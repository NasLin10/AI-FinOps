import { buildRequest, interpretRaw, type PlanOutcome } from '../../webview/src/api';
import type { ModelOption } from '../../webview/src/protocol';
import { EMPTY_FORM, type FormState, type Preference } from '../../webview/src/state';
import { postPlan } from '../../src/backend';
import type { Fake } from './fakeBackend';
import type { UiPlan } from '../../webview/src/plan';
import assert from 'node:assert/strict';

export const TOKEN = 'test-token';

export const MODELS: ModelOption[] = [
  { id: 'eco', displayName: 'Эко', tier: 'economy', notes: 'дешёвая' },
  { id: 'mid', displayName: 'Баланс', tier: 'balanced' },
  { id: 'pro', displayName: 'Про', tier: 'premium', notes: 'сильный reasoning' },
];

export const FORM: FormState = {
  ...EMPTY_FORM,
  taskText: 'Добавить экспорт отчёта в PDF с учётом текущих фильтров',
  stack: 'TypeScript, React',
  constraints: '- Не менять фильтрацию',
};

export interface AskOpts {
  form?: FormState;
  selected?: string[];
  preference?: Preference;
  answers?: Array<{ questionId: string; answer: string }>;
  token?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  requestId?: string;
}

/** Полный путь запроса: сборка тела → настоящий HTTP на сервер → разбор ответа интерфейсом. */
export async function ask(fake: Fake | { url: string }, o: AskOpts = {}): Promise<{ out: PlanOutcome; req: Awaited<ReturnType<typeof buildRequest>> }> {
  const selected = o.selected ?? MODELS.map((m) => m.id);
  const requestId = o.requestId ?? crypto.randomUUID();
  const req = await buildRequest({
    requestId,
    form: o.form ?? FORM,
    preference: o.preference ?? 'balanced',
    models: MODELS.filter((m) => selected.includes(m.id)),
    answers: o.answers ?? [],
  });
  const raw = await postPlan({ base: fake.url, token: o.token ?? TOKEN, body: JSON.stringify(req), timeoutMs: o.timeoutMs ?? 5000, signal: o.signal });
  const out = interpretRaw(raw, {
    requestId,
    selectedModelIds: selected,
    hasContext: req.context.length > 0,
    hadAnswers: (o.answers ?? []).length > 0,
    apiBaseUrl: fake.url,
  });
  return { out, req };
}

export function expectPlan(out: PlanOutcome): UiPlan {
  assert.ok(out.ok && out.kind === 'plan', out.ok ? 'ожидался план' : `ошибка: ${out.error.code} ${out.error.message}`);
  return out.plan;
}

export function expectError(out: PlanOutcome) {
  assert.ok(!out.ok, 'ожидалась ошибка');
  return out.error;
}
