import type { ModelOption, RawResult } from './protocol';
import {
  ErrorEnvelopeSchema,
  LIMITS,
  SCHEMA_VERSION,
  SuccessSchema,
  type ApiMeta,
  type PlanRequest,
  type Question,
} from './schema';
import { CODE_CTX_ID, splitLines } from './format';
import { sanitizeRecommendations, toUiPlan, validatePlan, type UiPlan } from './plan';
import type { FormState, Preference } from './state';

export interface ApiError {
  code: string;
  message: string;
  retryable: boolean;
  details: Array<{ path?: string; code?: string; message?: string }>;
  retryAfter?: string;
}

export type PlanOutcome =
  | { ok: true; kind: 'plan'; plan: UiPlan; meta?: ApiMeta }
  | { ok: true; kind: 'clarification'; questions: Question[] }
  | { ok: false; cancelled: boolean; error: ApiError };

// ---------- проверка формы до запроса ----------

export const utf8Len = (s: string) => new TextEncoder().encode(s).length;

/** Сколько места занимают поля формы относительно лимитов backend (в байтах UTF-8, как считает сервер). */
export function usage(form: FormState) {
  return {
    task: utf8Len(form.taskText.trim()),
    other: [...splitLines(form.criteria), ...splitLines(form.constraints)].reduce((n, s) => n + utf8Len(s), 0),
    code: form.code.length,
  };
}

const fmt = (n: number) => n.toLocaleString('ru-RU');

export function checkForm(form: FormState): string[] {
  const errors: string[] = [];
  const u = usage(form);
  if (!form.taskText.trim()) errors.push('Введите полный текст задачи.');
  if (u.task > LIMITS.taskBytes) {
    errors.push(`Текст задачи занимает ${fmt(u.task)} байт при лимите ${fmt(LIMITS.taskBytes)}. Кириллица занимает 2 байта на символ, то есть около ${fmt(Math.floor(LIMITS.taskBytes / 2))} символов. Сократите текст: мы не обрезаем его молча.`);
  }
  if (u.other > LIMITS.otherBytes) {
    errors.push(`Критерии и ограничения занимают ${fmt(u.other)} байт при лимите ${fmt(LIMITS.otherBytes)}. Сократите их.`);
  }
  if (u.code > LIMITS.code) {
    errors.push(`Фрагмент кода длиннее ${fmt(LIMITS.code)} символов (сейчас ${fmt(u.code)}). Оставьте только нужные строки.`);
  }
  return errors;
}

// ---------- сборка запроса (контракт POST /v1/plans) ----------

async function sha256(text: string): Promise<string> {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return 'sha256:' + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return 'sha256:unavailable';
  }
}

export async function buildRequest(args: {
  requestId: string;
  form: FormState;
  preference: Preference;
  models: ModelOption[]; // уже отфильтрованы по выбору пользователя
  answers: Array<{ questionId: string; answer: string }>;
}): Promise<PlanRequest> {
  const { form } = args;
  const code = form.code.trim();
  return {
    schemaVersion: SCHEMA_VERSION,
    requestId: args.requestId,
    epic: {
      text: form.taskText.trim(),
      acceptanceCriteria: splitLines(form.criteria),
      constraints: splitLines(form.constraints),
      nonGoals: [],
    },
    preference: args.preference,
    projectProfile: {
      stack: form.stack
        .split(/[,;\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
      text: form.stack.trim(),
    },
    context: code
      ? [
          {
            id: CODE_CTX_ID,
            path: 'фрагмент из формы',
            startLine: 1,
            endLine: code.split('\n').length,
            contentHash: await sha256(code),
            content: code,
          },
        ]
      : [],
    allowedModels: args.models.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      params: [`tier: ${m.tier}`, ...(m.notes ? [`notes: ${m.notes}`] : [])],
    })),
    catalog: { source: 'manual', fetchedAt: new Date().toISOString() },
    // Backend читает поле id, расширенное ТЗ называет его questionId: отправляем оба имени.
    clarificationAnswers: args.answers.map((a) => ({ id: a.questionId, questionId: a.questionId, answer: a.answer })),
  };
}

export const requestSize = (req: PlanRequest) => new TextEncoder().encode(JSON.stringify(req)).length;

// ---------- разбор ответа ----------

export const ERROR_TITLES: Record<string, string> = {
  VALIDATION_ERROR: 'Backend отклонил данные',
  CONTEXT_TOO_LARGE: 'Слишком большой запрос',
  AUTH_REQUIRED: 'Нужна авторизация',
  RATE_LIMITED: 'Слишком много запросов',
  PROVIDER_UNAVAILABLE: 'LLM-провайдер недоступен',
  PROVIDER_TIMEOUT: 'LLM-провайдер не ответил вовремя',
  MODEL_OUTPUT_INVALID: 'Модель вернула некорректный план',
  CANCELLED: 'Запрос отменён',
  INTERNAL_ERROR: 'Внутренняя ошибка backend',
  NETWORK_ERROR: 'Нет связи с backend',
  CLIENT_TIMEOUT: 'Backend не ответил вовремя',
  REQUEST_BLOCKED: 'Запрос не отправлен',
  BAD_RESPONSE: 'Непонятный ответ backend',
  CLARIFICATION_LOOP: 'Модель снова задала вопросы',
  REQUEST_IN_PROGRESS: 'Запрос уже выполняется',
};

/** Сообщения backend на английском: объясняем по-русски, что это значит и что делать. */
function localize(code: string, serverMessage: string): string {
  switch (code) {
    case 'VALIDATION_ERROR':
      return `Backend отклонил запрос: ${serverMessage}`;
    case 'MODEL_OUTPUT_INVALID':
      return `Нейросеть вернула план, который не прошёл проверку на сервере (${serverMessage}). Обычно помогает повторить запрос.`;
    case 'PROVIDER_UNAVAILABLE':
      return 'Сервер не смог получить ответ от нейросети. Проверьте LLM_API_KEY, LLM_BASE_URL и LLM_MODEL в .env бэкенда и повторите запрос.';
    case 'INTERNAL_ERROR':
      return 'Ошибка на сервере при сохранении плана. Проверьте, что база данных запущена и миграция применена.';
    default:
      return serverMessage;
  }
}

const fail = (error: Partial<ApiError> & Pick<ApiError, 'code' | 'message'>, cancelled = false): PlanOutcome => ({
  ok: false,
  cancelled,
  error: { retryable: false, details: [], ...error },
});

function statusFallback(status: number, retryAfter?: string): ApiError {
  if (status === 401 || status === 403) {
    return { code: 'AUTH_REQUIRED', message: 'Backend не принял токен доступа. Задайте его командой «Декомпозитор: задать токен доступа».', retryable: false, details: [] };
  }
  if (status === 413) {
    return { code: 'CONTEXT_TOO_LARGE', message: 'Запрос превышает лимит backend. Сократите текст задачи или фрагмент кода.', retryable: false, details: [] };
  }
  if (status === 429) {
    return { code: 'RATE_LIMITED', message: `Слишком много запросов.${retryAfter ? ` Повторите через ${retryAfter} с.` : ''}`, retryable: true, details: [], retryAfter };
  }
  if (status >= 500) {
    return { code: 'PROVIDER_UNAVAILABLE', message: `Backend вернул ошибку ${status}. Повторите попытку позже.`, retryable: true, details: [] };
  }
  return { code: 'BAD_RESPONSE', message: `Неожиданный ответ backend (HTTP ${status}).`, retryable: false, details: [] };
}

export interface InterpretCtx {
  requestId: string;
  selectedModelIds: string[];
  hasContext: boolean;
  /** true, если в запросе уже были ответы на уточнения. */
  hadAnswers: boolean;
  apiBaseUrl?: string;
}

/** Превращает сырой сетевой результат в понятный интерфейсу исход. */
export function interpretRaw(raw: RawResult, ctx: InterpretCtx): PlanOutcome {
  switch (raw.kind) {
    case 'cancelled':
      return fail({ code: 'CANCELLED', message: 'Запрос отменён. Введённые данные сохранены. Возможное списание за уже начатую генерацию не исключено.', retryable: true }, true);
    case 'timeout':
      return fail({ code: 'CLIENT_TIMEOUT', message: 'Backend не ответил за отведённое время. Введённые данные сохранены; запрос мог быть обработан, повторите вручную.', retryable: true });
    case 'network':
      return fail({
        code: 'NETWORK_ERROR',
        message: `Не удалось связаться с backend${ctx.apiBaseUrl ? ` (${ctx.apiBaseUrl})` : ''}. Проверьте, что сервис запущен и адрес указан верно. Детали: ${raw.message}`,
        retryable: true,
      });
    case 'blocked':
      return fail({ code: 'REQUEST_BLOCKED', message: raw.message });
    case 'http':
      break;
  }

  if (raw.status < 200 || raw.status >= 300) {
    const env = ErrorEnvelopeSchema.safeParse(raw.body);
    if (env.success) {
      const e = env.data.error;
      // Сообщение backend на английском: для авторизации подсказываем, что делать.
      if (e.code === 'AUTH_REQUIRED') return fail(statusFallback(401));
      return fail({ code: e.code, message: localize(e.code, e.message), retryable: Boolean(e.retryable) || e.code === 'MODEL_OUTPUT_INVALID' || e.code === 'PROVIDER_UNAVAILABLE', details: e.details ?? [], retryAfter: raw.retryAfter });
    }
    const fb = statusFallback(raw.status, raw.retryAfter);
    return fail(fb);
  }

  const parsed = SuccessSchema.safeParse(raw.body);
  if (!parsed.success) {
    return fail({
      code: 'MODEL_OUTPUT_INVALID',
      message: 'Ответ backend не соответствует ожидаемой схеме: не хватает обязательных полей или они заполнены неверно.',
      retryable: true,
      details: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.') || '(корень)', code: i.code, message: i.message })),
    });
  }

  const data = parsed.data;
  if (data.requestId !== ctx.requestId) {
    return fail({ code: 'BAD_RESPONSE', message: 'Ответ относится к другому запросу и был проигнорирован.', retryable: true });
  }

  if (data.kind === 'clarification') {
    if (ctx.hadAnswers) {
      return fail({
        code: 'CLARIFICATION_LOOP',
        message: 'Модель снова запросила уточнения, а в этой версии разрешён один раунд. Дополните описание задачи или критерии вручную и запустите разбиение заново.',
      });
    }
    return { ok: true, kind: 'clarification', questions: data.questions };
  }

  const ui = sanitizeRecommendations(toUiPlan(data.plan, data.meta), ctx.selectedModelIds);
  // Незаполненные поля (например, пустой «ожидаемый результат») не отклоняют план: их можно дописать в интерфейсе.
  const issues = validatePlan(ui.tasks, { contextIds: ctx.hasContext ? ['epic', CODE_CTX_ID] : ['epic'] }).filter(
    (i) => i.severity === 'error' && i.code !== 'EMPTY_FIELD',
  );
  if (issues.length) {
    return fail({
      code: 'MODEL_OUTPUT_INVALID',
      message: 'План не прошёл проверку структуры и зависимостей. Повторите запрос вручную.',
      retryable: true,
      details: issues.slice(0, 10).map((i) => ({ path: i.path, code: i.code, message: i.message })),
    });
  }
  return { ok: true, kind: 'plan', plan: ui, meta: data.meta };
}
