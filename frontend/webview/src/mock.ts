import type { RawResult } from './protocol';
import { SCHEMA_VERSION, type PlanRequest } from './schema';
import type { Preference, Scenario } from './state';

export const DEMO_PLANNER = 'demo-fixture';

export const SCENARIO_LABEL: Record<Scenario, string> = {
  large: 'Крупная задача (5 подзадач)',
  simple: 'Простая задача (1 подзадача)',
  error: 'Ошибка API (503)',
  clarification: 'Нужны уточнения (затем план)',
  invalid: 'Битый ответ модели (цикл)',
};

const TIER_RANK = { economy: 0, balanced: 1, premium: 2 } as const;

type Need = 0 | 1 | 2;

interface Draft {
  id: string;
  title: string;
  goal: string;
  expectedOutputs: string[];
  acceptanceCriteria: string[];
  dependsOn: string[];
  risk: 'low' | 'medium' | 'high';
  need: Need;
  why: string;
  assumptions?: string[];
}

/** Подбирает модель только из переданного (выбранного пользователем) списка. */
export function pickModel(
  models: PlanRequest['allowedModels'],
  need: Need,
  preference: Preference,
  risk: 'low' | 'medium' | 'high',
  why: string,
): { id: string | null; reasons: string[] } {
  if (models.length === 0) return { id: null, reasons: ['Модели не выбраны — рекомендация недоступна.'] };

  let target = need;
  if (preference === 'quality') target = Math.min(2, need + 1) as Need;
  if (preference === 'cost') target = Math.max(risk === 'high' ? 1 : 0, need - 1) as Need;

  const rank = (m: PlanRequest['allowedModels'][number]) => TIER_RANK[m.tier as keyof typeof TIER_RANK] ?? 1;
  // ближайший по уровню; при равенстве — более сильный, кроме предпочтения «Стоимость»
  const sorted = [...models].sort((a, b) => {
    const da = Math.abs(rank(a) - target);
    const db = Math.abs(rank(b) - target);
    if (da !== db) return da - db;
    return preference === 'cost' ? rank(a) - rank(b) : rank(b) - rank(a);
  });
  const best = sorted[0]!;
  const reasons = [why];
  if (rank(best) !== target) reasons.push(`Среди выбранных моделей нет точного соответствия, взята ближайшая: ${best.displayName}.`);
  if (risk === 'high') reasons.push('Высокий риск: проверьте выбор модели вручную и уделите больше внимания проверке результата.');
  return { id: best.id, reasons };
}

function buildPlan(req: PlanRequest, drafts: Draft[], summary: string, extraAssumptions: string[] = []) {
  const hasCode = req.context.length > 0;
  return {
    id: crypto.randomUUID(),
    version: 1,
    summary,
    assumptions: [
      ...extraAssumptions,
      ...(hasCode ? [] : ['Исходный код не передан: пути файлов и названия функций — предположения.']),
    ],
    warnings: ['Демо: без API. План собран из встроенного шаблона и не зависит от текста вашей задачи.'],
    tasks: drafts.map((d) => {
      const m = pickModel(req.allowedModels, d.need, req.preference, d.risk, d.why);
      return {
        id: d.id,
        title: d.title,
        goal: d.goal,
        expectedOutputs: d.expectedOutputs,
        acceptanceCriteria: d.acceptanceCriteria,
        dependsOn: d.dependsOn,
        contextRefs: hasCode ? ['ctx-1'] : [],
        assumptions: d.assumptions ?? [],
        risk: d.risk,
        recommendedModelId: m.id,
        recommendedParams: [],
        recommendationReasons: m.reasons,
        recommendationSource: 'demo-policy',
      };
    }),
  };
}

const LARGE: Draft[] = [
  {
    id: 'S1',
    title: 'Согласовать контракт экспорта',
    goal: 'Определить формат выгрузки, набор полей и поведение в крайних случаях до начала реализации.',
    expectedOutputs: ['Описание контракта данных: поля, типы, порядок колонок', 'Решение по пустой выборке и большим объёмам'],
    acceptanceCriteria: [
      'Для пустой выборки определён результат (сообщение или пустой файл)',
      'Перечислены все поля и правила их форматирования',
      'Контракт не требует менять существующую фильтрацию',
    ],
    dependsOn: [],
    risk: 'medium',
    need: 2,
    why: 'Нужно согласовать интерфейсы и ограничения до реализации.',
  },
  {
    id: 'S2',
    title: 'Подготовка данных экспорта',
    goal: 'Реализовать чистую функцию, которая по текущим фильтрам готовит строки отчёта.',
    expectedOutputs: ['Чистая функция подготовки строк', 'Юнит-тесты функции'],
    acceptanceCriteria: [
      'В результат попадают только выбранные строки',
      'Пустая выборка обработана по контракту из S1',
      'Входные данные не мутируются',
    ],
    dependsOn: ['S1'],
    risk: 'low',
    need: 0,
    why: 'Небольшая область изменения и готовые критерии проверки.',
  },
  {
    id: 'S3',
    title: 'Генерация PDF-документа',
    goal: 'Собрать PDF из подготовленных строк с учётом контракта.',
    expectedOutputs: ['Модуль генерации PDF', 'Тест на корректность структуры файла'],
    acceptanceCriteria: [
      'PDF открывается и содержит все строки из S2',
      'Форматирование колонок соответствует контракту S1',
      'Ошибки генерации возвращаются как управляемые, а не падают',
    ],
    dependsOn: ['S2'],
    risk: 'medium',
    need: 1,
    why: 'Типовая задача в одном модуле с умеренной сложностью.',
    assumptions: ['Библиотека для PDF ещё не выбрана — выбор остаётся за исполнителем.'],
  },
  {
    id: 'S4',
    title: 'Кнопка экспорта и состояния интерфейса',
    goal: 'Добавить кнопку «Экспорт в PDF» с состояниями загрузки и ошибки.',
    expectedOutputs: ['Компонент кнопки экспорта', 'Тест компонента'],
    acceptanceCriteria: [
      'Кнопка недоступна при пустой выборке',
      'Во время генерации показан индикатор',
      'Ошибка отображается без потери текущих фильтров',
    ],
    dependsOn: ['S3'],
    risk: 'low',
    need: 0,
    why: 'Ограниченное изменение интерфейса с готовыми критериями.',
  },
  {
    id: 'S5',
    title: 'Интеграция и итоговая проверка',
    goal: 'Убедиться, что шаги состыкованы и сценарий работает целиком.',
    expectedOutputs: ['Сквозной тест сценария экспорта', 'Список найденных расхождений между шагами'],
    acceptanceCriteria: [
      'Экспорт с активными фильтрами даёт PDF только с выбранными строками',
      'Существующая фильтрация работает без изменений',
      'Тесты S2–S4 проходят вместе',
    ],
    dependsOn: ['S2', 'S3', 'S4'],
    risk: 'high',
    need: 2,
    why: 'Шаги могут пройти независимо и не состыковаться, нужна сверка целого.',
  },
];

const SIMPLE: Draft[] = [
  {
    id: 'S1',
    title: 'Исправить дефект и добавить регрессионный тест',
    goal: 'Локализовать причину ошибки, исправить её минимальным изменением и закрепить тестом.',
    expectedOutputs: ['Исправление в затронутом модуле', 'Регрессионный тест, воспроизводящий ошибку'],
    acceptanceCriteria: [
      'Тест падает до исправления и проходит после',
      'Существующие тесты модуля проходят без изменений',
      'Изменения ограничены затронутым модулем',
    ],
    dependsOn: [],
    risk: 'low',
    need: 0,
    why: 'Небольшая область изменения и проверяемый критерий.',
  },
];

const BROKEN: Draft[] = [
  { ...LARGE[0]!, dependsOn: ['S2'] },
  { ...LARGE[1]!, dependsOn: ['S1'] },
  { ...LARGE[2]!, dependsOn: ['S9'] },
];

const QUESTIONS = [
  { id: 'q1', text: 'Что должно попадать в отчёт: только выбранные пользователем строки или вся таблица?', reason: 'От этого зависит контракт данных.' },
  { id: 'q2', text: 'Есть ли ограничения по размеру файла или числу строк?', reason: 'Влияет на способ генерации PDF.' },
  { id: 'q3', text: 'Нужно ли поддерживать другие форматы, кроме PDF?', reason: 'Определяет, нужен ли общий интерфейс экспортёра.' },
];

const meta = (calls: number) => ({
  plannerModel: DEMO_PLANNER,
  promptVersion: 'demo',
  policyVersion: 'demo',
  latencyMs: 1200,
  providerCalls: calls,
  usage: { inputTokens: null, outputTokens: null },
  cost: null,
});

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<boolean>((resolve) => {
    if (signal.aborted) return resolve(false);
    const t = setTimeout(() => resolve(true), ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve(false);
      },
      { once: true },
    );
  });

/** Имитирует ответ backend в том же «сыром» виде, что и настоящий сетевой вызов. */
export async function mockRequest(req: PlanRequest, scenario: Scenario, signal: AbortSignal): Promise<RawResult> {
  const finished = await wait(900 + Math.random() * 900, signal);
  if (!finished) return { kind: 'cancelled' };

  const base = { schemaVersion: SCHEMA_VERSION, requestId: req.requestId };
  const summaryOf = (label: string) => `${label}: «${req.epic.text.replace(/\s+/g, ' ').slice(0, 70)}${req.epic.text.length > 70 ? '…' : ''}»`;

  switch (scenario) {
    case 'error':
      return {
        kind: 'http',
        status: 503,
        body: {
          requestId: req.requestId,
          error: { code: 'PROVIDER_UNAVAILABLE', message: 'LLM-провайдер временно недоступен.', retryable: true },
        },
      };
    case 'simple':
      return {
        kind: 'http',
        status: 200,
        body: { ...base, kind: 'plan', plan: buildPlan(req, SIMPLE, `Задача небольшая, оставлена одной подзадачей — ${summaryOf('дробление не требуется')}`), meta: meta(1) },
      };
    case 'invalid':
      return {
        kind: 'http',
        status: 200,
        body: { ...base, kind: 'plan', plan: buildPlan(req, BROKEN, summaryOf('План')), meta: meta(1) },
      };
    case 'clarification':
      if (req.clarificationAnswers.length === 0) {
        return { kind: 'http', status: 200, body: { ...base, kind: 'clarification', questions: QUESTIONS, meta: meta(1) } };
      }
      return {
        kind: 'http',
        status: 200,
        body: {
          ...base,
          kind: 'plan',
          plan: buildPlan(
            req,
            LARGE,
            summaryOf('План с учётом ответов'),
            req.clarificationAnswers.filter((a) => a.answer.trim()).map((a) => `Ответ на уточнение: ${a.answer.trim()}`),
          ),
          meta: meta(1),
        },
      };
    case 'large':
    default:
      return {
        kind: 'http',
        status: 200,
        body: { ...base, kind: 'plan', plan: buildPlan(req, LARGE, summaryOf('План')), meta: meta(1) },
      };
  }
}
