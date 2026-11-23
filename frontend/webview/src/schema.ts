import { z } from 'zod';

export const SCHEMA_VERSION = '1.0';
export const MAX_TASKS = 7;

export const RiskSchema = z.enum(['low', 'medium', 'high']);
export type Risk = z.infer<typeof RiskSchema>;

const nonEmpty = z.string().trim().min(1);

export const ApiTaskSchema = z.object({
  id: nonEmpty,
  title: nonEmpty,
  goal: nonEmpty,
  expectedOutputs: z.array(nonEmpty).min(1),
  acceptanceCriteria: z.array(nonEmpty).min(1),
  dependsOn: z.array(z.string()),
  contextRefs: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  risk: RiskSchema,
  recommendedModelId: z.string().nullable(),
  recommendedParams: z.array(z.unknown()).default([]),
  recommendationReasons: z.array(z.string()).default([]),
  recommendationSource: z.string().optional(),
});
export type ApiTask = z.infer<typeof ApiTaskSchema>;

export const ApiPlanSchema = z.object({
  id: nonEmpty,
  version: z.number().int(),
  summary: nonEmpty,
  assumptions: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
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
  reason: z.string().optional(),
});
export type Question = z.infer<typeof QuestionSchema>;

export const ClarificationResponseSchema = z.object({
  schemaVersion: z.string(),
  requestId: z.string(),
  kind: z.literal('clarification'),
  questions: z.array(QuestionSchema).min(1).max(3),
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
  allowedModels: Array<{ id: string; displayName: string; tier: string; notes?: string; params: unknown[] }>;
  catalog: { source: 'manual'; fetchedAt: string };
  clarificationAnswers: Array<{ questionId: string; answer: string }>;
}

export const LIMITS = {
  taskText: 10_000,
  extras: 6_000, // ограничения + критерии + стек суммарно
  code: 36_000,
  requestBytes: 256 * 1024,
} as const;
