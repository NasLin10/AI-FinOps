import type { ModelOption } from './protocol';
import type { FormState, Preference } from './state';
import { SCHEMA_VERSION } from './schema';
import type { UiPlan, UiTask, TaskStatus } from './plan';
import { topoOrder } from './plan';

export const CODE_CTX_ID = 'ctx-1';

export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'Не начата',
  copied: 'Передана агенту',
  done: 'Выполнена',
  failed: 'Не выполнена',
};
export const RISK_LABEL = { low: 'Низкий риск', medium: 'Средний риск', high: 'Высокий риск' } as const;
export const TIER_LABEL = { economy: 'экономичная', balanced: 'сбалансированная', premium: 'премиальная' } as const;
export const PREF_LABEL: Record<Preference, string> = { balanced: 'Баланс', quality: 'Качество', cost: 'Стоимость' };

/** Многострочное поле → список пунктов (маркеры списка убираются). */
export function splitLines(s: string): string[] {
  return s
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
    .filter(Boolean);
}

export const joinLines = (items: string[]) => items.join('\n');

const shorten = (s: string, n: number) => {
  const flat = s.trim().replace(/\s+/g, ' ');
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

const modelName = (models: ModelOption[], id: string | null) =>
  id ? (models.find((m) => m.id === id)?.displayName ?? id) : null;

/** Ограждение для блока кода, которое не ломается от обратных кавычек внутри. */
export function fenceFor(code: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((m) => m.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

export function mdEscape(s: string): string {
  return s
    .replace(/([\\`*_[\]<>|])/g, '\\$1')
    .split('\n')
    .map((line) => line.replace(/^(\s*)([#+-]|\d+\.)(\s)/, '$1\\$2$3'))
    .join('\n');
}

function includesCode(plan: UiPlan, task: UiTask, form: FormState): boolean {
  if (!form.code.trim()) return false;
  return task.contextRefs.includes(CODE_CTX_ID) || plan.tasks.every((t) => t.contextRefs.length === 0);
}

/** Явный список того, что неизвестно: чтобы агент не додумывал факты о проекте. */
export function unknownsFor(plan: UiPlan, task: UiTask, form: FormState): string[] {
  const out = [...task.assumptions, ...plan.assumptions.filter((a) => !task.assumptions.includes(a))];
  if (!form.stack.trim()) out.push('Стек проекта не указан.');
  if (!form.code.trim()) out.push('Исходный код не предоставлен: пути файлов и сигнатуры — предположение, сверьтесь с репозиторием.');
  if (splitLines(form.criteria).length === 0) out.push('Критерии готовности всего эпика пользователь не задавал.');
  return out;
}

const bullets = (items: string[], empty = 'не указаны') =>
  items.length ? items.map((i) => `- ${i}`).join('\n') : empty;

/** Текст задания для вставки в coding-агента. Модель в текст не входит: она показывается отдельно. */
export function taskToPrompt(plan: UiPlan, task: UiTask, form: FormState): string {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const deps = task.dependsOn.map((d) => byId.get(d)).filter((t): t is UiTask => Boolean(t));
  const parts: string[] = [];

  parts.push(`# Подзадача ${task.id}: ${task.title}`);
  parts.push(`Цель эпика: ${shorten(form.taskText, 400) || 'не указана'}`);
  parts.push(`Цель шага: ${task.goal}`);
  parts.push(`Результат шага:\n${bullets(task.expectedOutputs)}`);

  if (deps.length) {
    parts.push(
      `Зависимости: ${deps.map((d) => `${d.id} «${d.title}»`).join(', ')}.\n` +
        `Входы от предыдущих шагов (приложите их результат к заданию):\n` +
        deps.map((d) => `- ${d.id}: ${d.expectedOutputs.join('; ')}`).join('\n'),
    );
  } else {
    parts.push('Зависимости: нет.');
  }

  parts.push(`Ограничения:\n${bullets(splitLines(form.constraints))}`);
  parts.push(`Критерии готовности:\n${bullets(task.acceptanceCriteria)}`);

  const ctx: string[] = [`- Стек: ${form.stack.trim() || 'не указан'}`];
  if (includesCode(plan, task, form)) {
    const fence = fenceFor(form.code);
    ctx.push(`- Фрагмент кода от пользователя:\n${fence}\n${form.code.trim()}\n${fence}`);
  }
  parts.push(`Контекст:\n${ctx.join('\n')}`);

  parts.push('Проверка: по критериям готовности выше; команды проверки проекта не заданы.');
  parts.push(`Неизвестное:\n${bullets(unknownsFor(plan, task, form), 'нет')}`);

  return parts.join('\n\n') + '\n';
}

export function planToMarkdown(plan: UiPlan, form: FormState, models: ModelOption[], preference: Preference): string {
  const order = topoOrder(plan.tasks);
  const L: string[] = [];
  L.push(`# План: ${mdEscape(plan.summary)}`);
  L.push(`**Эпик:** ${mdEscape(shorten(form.taskText, 600))}`);
  L.push(`_Предварительный план. Рекомендации моделей предварительные (предпочтение: ${PREF_LABEL[preference]}); статусы проставлены вручную пользователем._`);
  if (order) L.push(`**Порядок исполнения:** ${order.join(' → ')}`);
  if (plan.warnings.length) L.push(`## Предупреждения\n${plan.warnings.map((w) => `- ${mdEscape(w)}`).join('\n')}`);
  if (plan.assumptions.length) L.push(`## Допущения\n${plan.assumptions.map((a) => `- ${mdEscape(a)}`).join('\n')}`);

  for (const t of plan.tasks) {
    const model = modelName(models, t.recommendedModelId);
    const lines = [
      `## ${t.id}. ${mdEscape(t.title)}`,
      `- **Статус:** ${STATUS_LABEL[t.status]}${t.needsRecheck ? ' (требует перепроверки)' : ''}${
        t.verdictNote ? ` — ${mdEscape(t.verdictNote)}` : ''
      }`,
      `- **Цель:** ${mdEscape(t.goal)}`,
      `- **Ожидаемый результат:**\n${t.expectedOutputs.map((o) => `  - ${mdEscape(o)}`).join('\n')}`,
      `- **Критерии готовности:**\n${t.acceptanceCriteria.map((o) => `  - ${mdEscape(o)}`).join('\n')}`,
      `- **Зависит от:** ${t.dependsOn.length ? t.dependsOn.join(', ') : 'нет'}`,
      `- **Риск:** ${RISK_LABEL[t.risk]}`,
      `- **Модель (предварительно):** ${
        model ? `${mdEscape(model)}${t.recommendationReasons.length ? ` — ${mdEscape(t.recommendationReasons.join(' '))}` : ''}` : 'не выбрана'
      }`,
    ];
    if (t.assumptions.length) lines.push(`- **Допущения:** ${t.assumptions.map(mdEscape).join('; ')}`);
    L.push(lines.join('\n'));
  }
  return L.join('\n\n') + '\n';
}

export function planToJson(
  plan: UiPlan,
  form: FormState,
  models: ModelOption[],
  selectedModelIds: string[],
  preference: Preference,
): string {
  const { meta: _meta, ...planWithoutMeta } = plan;
  void _meta;
  return JSON.stringify(
    {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      note: 'Рекомендации моделей предварительные; статусы выставлены пользователем вручную.',
      epic: {
        text: form.taskText,
        stack: form.stack,
        constraints: splitLines(form.constraints),
        acceptanceCriteria: splitLines(form.criteria),
      },
      preference,
      availableModels: models.filter((m) => selectedModelIds.includes(m.id)),
      executionOrder: topoOrder(plan.tasks),
      plan: planWithoutMeta,
    },
    null,
    2,
  );
}
