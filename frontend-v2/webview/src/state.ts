import type { Question } from './schema';
import type { UiPlan } from './plan';

export type Preference = 'balanced' | 'quality' | 'cost';

export interface FormState {
  taskText: string;
  stack: string;
  constraints: string;
  criteria: string;
  code: string;
}

export interface PendingClarification {
  questions: Question[];
  answers: Record<string, string>;
}

export interface PersistedState {
  v: 2;
  form: FormState;
  /** null — пользователь ещё не выбирал, по умолчанию отмечены все модели из настройки. */
  selectedModelIds: string[] | null;
  preference: Preference;
  plan: UiPlan | null;
  pending: PendingClarification | null;
}

export const EMPTY_FORM: FormState = { taskText: '', stack: '', constraints: '', criteria: '', code: '' };

export const DEFAULT_STATE: PersistedState = {
  v: 2,
  form: EMPTY_FORM,
  selectedModelIds: null,
  preference: 'balanced',
  plan: null,
  pending: null,
};

/** Мягкая проверка сохранённого состояния: при несовпадении формата начинаем с чистого листа. */
export function restoreState(raw: unknown): PersistedState {
  if (!raw || typeof raw !== 'object') return DEFAULT_STATE;
  const s = raw as Partial<PersistedState>;
  if (s.v !== 2 || !s.form || typeof s.form !== 'object') return DEFAULT_STATE;
  const f = s.form as Partial<FormState>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    v: 2,
    form: { taskText: str(f.taskText), stack: str(f.stack), constraints: str(f.constraints), criteria: str(f.criteria), code: str(f.code) },
    selectedModelIds: Array.isArray(s.selectedModelIds) ? s.selectedModelIds.filter((x) => typeof x === 'string') : null,
    preference: s.preference === 'quality' || s.preference === 'cost' ? s.preference : 'balanced',
    plan: s.plan && Array.isArray(s.plan.tasks) ? s.plan : null,
    pending: s.pending && Array.isArray(s.pending.questions) ? s.pending : null,
  };
}
