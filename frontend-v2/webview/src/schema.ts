import { z } from 'zod';

export const SCHEMA_VERSION = '1.0';
export const MAX_TASKS = 7;

/** Реальные модели иногда пишут «High» или придумывают свои градации: неизвестное считаем средним риском. */
export const RiskSchema = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
  z.enum(['low', 'medium', 'high']).catch('medium'),
) as unknown as z.ZodType<'low' | 'medium' | 'high'>;
export type Risk = z.infer<typeof RiskSchema>;

const nonEmpty = z.string().trim().min(1);

/** Go-backend отдаёт незаполненные срезы как null, а не []: считаем null пустым массивом. */
const list = <T extends z.ZodTypeAny>(item: T) => z.preprocess((v) => v ?? [], z.array(item));

export const ApiTaskSchema = z.object({
  id: nonEmpty,
  title: nonEmpty,
  goal: nonEmpty,
  expectedOutputs: list(z.string()),
  acceptanceCriteria: list(nonEmpty).pipe(z.array(nonEmpty).min(1)),
  dependsOn: list(z.string()),
  contextRefs: list(z.string()),
  assumptions: list(z.string()),
  risk: RiskSchema,
  recommendedModelId: z.string().nullish().transform((v) => (v && v.trim() ? v : null)),
  recommendedParams: list(z.unknown()),
  recommendationReasons: list(z.string()),
  recommendationSource: z.string().nullish().transform((v) => v || undefined),
});
export type ApiTask = z.infer<typeof ApiTaskSchema>;

export const ApiPlanSchema = z.object({
  id: nonEmpty,
  version: z.number().int(),
  summary: z.string().default(''),
  assumptions: list(z.string()),
  warnings: list(z.string()),
  tasks: z.array(ApiTaskSchema),
});
export type ApiPlan = z.infer<typeof ApiPlanSchema>;

const MetaSchema = z.looseObject({
  plannerModel: z.string().optional(),
  promptVersion: z.string().optional(),
  policyVersion: z.string().optional(),
  latencyMs: z.number().nullable().optional(),
  providerCalls: z.number().optional(),
  usage: z
    .object({
      inputTokens: z.number().nullable().optional(),
      outputTokens: z.number().nullable().optional(),
    })
    .optional(),
  cost: z.unknown().optional(),
});
export type ApiMeta = z.infer<typeof MetaSchema>;

export const PlanResponseSchema = z.object({
  schemaVersion: z.string(),
  requestId: z.string(),
  kind: z.literal('plan'),
  plan: ApiPlanSchema,
  meta: MetaSchema.optional(),
});

export const QuestionSchema = z.object({
  id: nonEmpty,
  text: nonEmpty,
  reason: z.string().nullish().transform((v) => v || undefined),
});
export type Question = z.infer<typeof QuestionSchema>;

/** Модель может не указать или повторить id вопроса: делаем их уникальными, иначе ответы перепутаются. */
function withQuestionIds(v: unknown): unknown {
  if (!Array.isArray(v)) return v;
  const seen = new Set<string>();
  return v.map((q, i) => {
    if (!q || typeof q !== 'object') return q;
    let id = typeof (q as { id?: unknown }).id === 'string' ? (q as { id: string }).id.trim() : '';
    if (!id || seen.has(id)) id = `q${i + 1}`;
    while (seen.has(id)) id += '_';
    seen.add(id);
    return { ...q, id };
  });
}

export const ClarificationResponseSchema = z.object({
  schemaVersion: z.string(),
  requestId: z.string(),
  kind: z.literal('clarification'),
  questions: z.preprocess(withQuestionIds, z.array(QuestionSchema).min(1).transform((q) => q.slice(0, 3))),
  meta: MetaSchema.optional(),
});

export const SuccessSchema = z.discriminatedUnion('kind', [PlanResponseSchema, ClarificationResponseSchema]);
export type ApiSuccess = z.infer<typeof SuccessSchema>;

export const ErrorEnvelopeSchema = z.object({
  requestId: z.string().optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean().optional(),
    details: z
      .array(z.object({ path: z.string().optional(), code: z.string().optional(), message: z.string().optional() }))
      .optional(),
  }),
});

// ---------- запрос (раздел 10.1 расширенного ТЗ) ----------

export interface PlanRequest {
  schemaVersion: string;
  requestId: string;
  epic: {
    text: string;
    acceptanceCriteria: string[];
    constraints: string[];
    nonGoals: string[];
  };
  preference: 'balanced' | 'quality' | 'cost';
  projectProfile: { stack: string[]; text: string };
  context: Array<{
    id: string;
    path: string;
    startLine: number;
    endLine: number;
    contentHash: string;
    content: string;
  }>;
  /**
   * Backend знает у модели только id, displayName и params (список строк) и передаёт их LLM как есть.
   * Класс и описание модели кладём в params, иначе LLM выбирает по одному названию.
   */
  allowedModels: Array<{ id: string; displayName: string; params: string[] }>;
  catalog: { source: 'manual'; fetchedAt: string };
  clarificationAnswers: Array<{ id: string; questionId: string; answer: string }>;
}

/**
 * Лимиты backend. Он считает длину текста задачи и списков критериев/ограничений в БАЙТАХ UTF-8
 * (len() в Go), поэтому кириллица занимает вдвое больше места, чем латиница.
 */
export const LIMITS = {
  taskBytes: 10_000,
  otherBytes: 6_000, // критерии + ограничения (стек backend не ограничивает)
  code: 36_000, // символов; backend отдельно ограничивает только размер всего запроса
  requestBytes: 256 * 1024,
} as const;
