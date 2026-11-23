import { MAX_TASKS, type ApiMeta, type ApiPlan, type ApiTask } from './schema';

// ---------- типы интерфейсного плана ----------

export type TaskStatus = 'todo' | 'copied' | 'done' | 'failed';

export interface UiTask extends ApiTask {
  status: TaskStatus;
  /** Короткий комментарий к ручному вердикту. */
  verdictNote: string;
  /** Результат принят, но предшественник изменился или провалился. */
  needsRecheck: boolean;
  /** Смысл шага изменён после выдачи рекомендации модели. */
  recommendationStale: boolean;
}

export interface UiPlan {
  id: string;
  version: number;
  summary: string;
  assumptions: string[];
  warnings: string[];
  tasks: UiTask[];
  meta?: ApiMeta;
}

export function toUiPlan(plan: ApiPlan, meta?: ApiMeta): UiPlan {
  return {
    ...plan,
    meta,
    tasks: plan.tasks.map((t) => ({
      ...t,
      status: 'todo',
      verdictNote: '',
      needsRecheck: false,
      recommendationStale: false,
    })),
  };
}

// ---------- валидация ----------

export interface Issue {
  taskId?: string;
  path: string;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ValidateOpts {
  /** Если задан, ссылки на контекст проверяются по этому списку. */
  contextIds?: string[];
  /** Если задан, рекомендованные модели вне списка дают предупреждение. */
  selectedModelIds?: string[];
}

type TaskLike = Pick<
  ApiTask,
  'id' | 'title' | 'goal' | 'expectedOutputs' | 'acceptanceCriteria' | 'dependsOn' | 'contextRefs' | 'recommendedModelId'
>;

export function validatePlan(tasks: TaskLike[], opts: ValidateOpts = {}): Issue[] {
  const issues: Issue[] = [];
  const err = (taskId: string | undefined, path: string, code: string, message: string) =>
    issues.push({ taskId, path, code, message, severity: 'error' });

  if (tasks.length === 0) err(undefined, 'tasks', 'EMPTY_PLAN', 'В плане нет ни одной подзадачи.');
  if (tasks.length > MAX_TASKS) {
    err(undefined, 'tasks', 'TOO_MANY_TASKS', `Подзадач больше допустимого (${MAX_TASKS}).`);
  }

  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id)) err(t.id, 'tasks.id', 'DUPLICATE_ID', `Повторяющийся id «${t.id}».`);
    ids.add(t.id);
  }

  tasks.forEach((t, i) => {
    const p = `tasks[${i}]`;
    if (!t.title.trim()) err(t.id, `${p}.title`, 'EMPTY_FIELD', `${t.id}: заполните название.`);
    if (!t.goal.trim()) err(t.id, `${p}.goal`, 'EMPTY_FIELD', `${t.id}: заполните цель.`);
    if (!t.expectedOutputs.some((s) => s.trim())) {
      err(t.id, `${p}.expectedOutputs`, 'EMPTY_FIELD', `${t.id}: укажите ожидаемый результат.`);
    }
    if (!t.acceptanceCriteria.some((s) => s.trim())) {
      err(t.id, `${p}.acceptanceCriteria`, 'NO_CRITERIA', `${t.id}: нужен хотя бы один критерий готовности.`);
    }
    for (const d of t.dependsOn) {
      if (d === t.id) err(t.id, `${p}.dependsOn`, 'SELF_DEPENDENCY', `${t.id}: шаг не может зависеть от самого себя.`);
      else if (!ids.has(d)) err(t.id, `${p}.dependsOn`, 'MISSING_DEPENDENCY', `${t.id}: зависимость от несуществующего шага «${d}».`);
    }
    if (opts.contextIds) {
      for (const r of t.contextRefs) {
        if (!opts.contextIds.includes(r)) {
          err(t.id, `${p}.contextRefs`, 'UNKNOWN_CONTEXT_REF', `${t.id}: ссылка на неизвестный контекст «${r}».`);
        }
      }
    }
    if (opts.selectedModelIds && t.recommendedModelId && !opts.selectedModelIds.includes(t.recommendedModelId)) {
      issues.push({
        taskId: t.id,
        path: `${p}.recommendedModelId`,
        code: 'MODEL_NOT_SELECTED',
        message: `${t.id}: модель «${t.recommendedModelId}» не отмечена в списке доступных. Выберите другую.`,
        severity: 'warning',
      });
    }
  });

  const cycle = findCycle(tasks);
  if (cycle) err(cycle[0], 'tasks.dependsOn', 'CYCLE', `Циклическая зависимость: ${cycle.join(' → ')}.`);

  return issues;
}

export const hasErrors = (issues: Issue[]) => issues.some((i) => i.severity === 'error');

// ---------- граф зависимостей ----------

/** Возвращает путь по циклу (первый id повторяется в конце) или null. */
export function findCycle(tasks: Pick<ApiTask, 'id' | 'dependsOn'>[]): string[] | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, 0 | 1 | 2>(); // 1 — в обходе, 2 — завершён
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    stack.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) continue;
      if (state.get(dep) === 1) return [...stack.slice(stack.indexOf(dep)), dep];
      if (!state.has(dep)) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };

  for (const t of tasks) {
    if (!state.has(t.id)) {
      const found = visit(t.id);
      if (found) return found;
    }
  }
  return null;
}

/** Топологический порядок исполнения (стабильный по порядку строк); null при цикле. */
export function topoOrder(tasks: Pick<ApiTask, 'id' | 'dependsOn'>[]): string[] | null {
  const ids = new Set(tasks.map((t) => t.id));
  const remaining = new Map(tasks.map((t) => [t.id, new Set(t.dependsOn.filter((d) => ids.has(d) && d !== t.id))]));
  const order: string[] = [];
  while (remaining.size) {
    const next = tasks.find((t) => remaining.has(t.id) && remaining.get(t.id)!.size === 0);
    if (!next) return null;
    order.push(next.id);
    remaining.delete(next.id);
    for (const deps of remaining.values()) deps.delete(next.id);
  }
  return order;
}

/** Добавление «taskId зависит от depId» создаст цикл? */
export function wouldCreateCycle(tasks: Pick<ApiTask, 'id' | 'dependsOn'>[], taskId: string, depId: string): boolean {
  if (taskId === depId) return true;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const stack = [depId];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === taskId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(byId.get(cur)?.dependsOn ?? []));
  }
  return false;
}

/** Все шаги, которые прямо или косвенно зависят от id. */
export function dependentsOf(tasks: Pick<ApiTask, 'id' | 'dependsOn'>[], id: string): string[] {
  const result = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const t of tasks) {
      if (t.dependsOn.includes(cur) && !result.has(t.id)) {
        result.add(t.id);
        queue.push(t.id);
      }
    }
  }
  return [...result];
}

/** Шаги, которые прямо зависят от id. */
export const directDependents = (tasks: Pick<ApiTask, 'id' | 'dependsOn'>[], id: string) =>
  tasks.filter((t) => t.dependsOn.includes(id)).map((t) => t.id);

/** Шаг заблокирован, пока не выполнены все его зависимости. */
export function unmetDependencies(plan: UiPlan, task: UiTask): string[] {
  return task.dependsOn.filter((d) => plan.tasks.find((t) => t.id === d)?.status !== 'done');
}

// ---------- рекомендации моделей ----------

export const MODEL_DROPPED_REASON = 'Модель отсутствует в выбранном списке — рекомендация отброшена.';
export const NO_MODELS_REASON = 'Модели не выбраны — рекомендация недоступна.';

/** Гарантирует, что рекомендованы только выбранные пользователем модели. */
export function sanitizeRecommendations(plan: UiPlan, selectedModelIds: string[]): UiPlan {
  return {
    ...plan,
    tasks: plan.tasks.map((t) => {
      if (t.recommendedModelId === null || selectedModelIds.includes(t.recommendedModelId)) return t;
      const reason = selectedModelIds.length === 0 ? NO_MODELS_REASON : MODEL_DROPPED_REASON;
      return {
        ...t,
        recommendedModelId: null,
        recommendedParams: [],
        recommendationReasons: [...t.recommendationReasons, reason],
      };
    }),
  };
}

// ---------- редактирование (чистые функции) ----------

type SemanticPatch = Partial<
  Pick<UiTask, 'title' | 'goal' | 'expectedOutputs' | 'acceptanceCriteria' | 'risk' | 'dependsOn' | 'assumptions'>
>;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function markRecheck(tasks: UiTask[], sourceId: string): UiTask[] {
  const affected = new Set(dependentsOf(tasks, sourceId));
  return tasks.map((t) => (affected.has(t.id) && t.status === 'done' ? { ...t, needsRecheck: true } : t));
}

/** Правка смысла шага: сбрасывает принятый результат и устаревает рекомендацию. */
export function editTask(plan: UiPlan, id: string, patch: SemanticPatch): UiPlan {
  const current = plan.tasks.find((t) => t.id === id);
  if (!current) return plan;
  const changed = (Object.keys(patch) as (keyof SemanticPatch)[]).some((k) => !same(patch[k], current[k]));
  if (!changed) return plan;

  const wasAccepted = current.status === 'done';
  let tasks = plan.tasks.map((t) => {
    if (t.id !== id) return t;
    return {
      ...t,
      ...patch,
      status: t.status === 'done' || t.status === 'copied' ? ('todo' as const) : t.status,
      needsRecheck: false,
      recommendationStale: t.recommendedModelId !== null && t.recommendationSource !== 'user' ? true : t.recommendationStale,
    };
  });
  if (wasAccepted) tasks = markRecheck(tasks, id);
  return { ...plan, tasks };
}

export function setModel(plan: UiPlan, id: string, modelId: string | null): UiPlan {
  return {
    ...plan,
    tasks: plan.tasks.map((t) =>
      t.id === id
        ? {
            ...t,
            recommendedModelId: modelId,
            recommendedParams: [],
            recommendationSource: 'user',
            recommendationReasons: [modelId ? 'Выбрано пользователем вручную.' : 'Модель не выбрана.'],
            recommendationStale: false,
          }
        : t,
    ),
  };
}

export function setStatus(plan: UiPlan, id: string, status: TaskStatus, note?: string): UiPlan {
  const current = plan.tasks.find((t) => t.id === id);
  if (!current) return plan;
  let tasks = plan.tasks.map((t) =>
    t.id === id ? { ...t, status, needsRecheck: false, verdictNote: note ?? t.verdictNote } : t,
  );
  if (current.status === 'done' && status !== 'done') tasks = markRecheck(tasks, id);
  return { ...plan, tasks };
}

export function setNote(plan: UiPlan, id: string, note: string): UiPlan {
  return { ...plan, tasks: plan.tasks.map((t) => (t.id === id ? { ...t, verdictNote: note } : t)) };
}

export function markCopied(plan: UiPlan, id: string): UiPlan {
  return {
    ...plan,
    tasks: plan.tasks.map((t) => (t.id === id && t.status === 'todo' ? { ...t, status: 'copied' as const } : t)),
  };
}

export type RemoveResult = { ok: true; plan: UiPlan } | { ok: false; blockedBy: string[] };

/** Удаление шага с зависимыми шагами запрещено, пока зависимости не сняты. */
export function removeTask(plan: UiPlan, id: string): RemoveResult {
  const blockedBy = directDependents(plan.tasks, id);
  if (blockedBy.length) return { ok: false, blockedBy };
  return { ok: true, plan: { ...plan, tasks: plan.tasks.filter((t) => t.id !== id) } };
}

export function moveTask(plan: UiPlan, id: string, delta: -1 | 1): UiPlan {
  const i = plan.tasks.findIndex((t) => t.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= plan.tasks.length) return plan;
  const tasks = [...plan.tasks];
  [tasks[i], tasks[j]] = [tasks[j]!, tasks[i]!];
  return { ...plan, tasks };
}

export function nextTaskId(tasks: Pick<ApiTask, 'id'>[]): string {
  const max = tasks.reduce((m, t) => {
    const n = /^S(\d+)$/.exec(t.id);
    return n ? Math.max(m, Number(n[1])) : m;
  }, 0);
  return `S${max + 1}`;
}

export function addTask(plan: UiPlan): { plan: UiPlan; id: string } | null {
  if (plan.tasks.length >= MAX_TASKS) return null;
  const id = nextTaskId(plan.tasks);
  const task: UiTask = {
    id,
    title: 'Новая подзадача',
    goal: '',
    expectedOutputs: [],
    acceptanceCriteria: [],
    dependsOn: [],
    contextRefs: [],
    assumptions: [],
    risk: 'medium',
    recommendedModelId: null,
    recommendedParams: [],
    recommendationReasons: ['Модель не выбрана.'],
    recommendationSource: 'user',
    status: 'todo',
    verdictNote: '',
    needsRecheck: false,
    recommendationStale: false,
  };
  return { plan: { ...plan, tasks: [...plan.tasks, task] }, id };
}
