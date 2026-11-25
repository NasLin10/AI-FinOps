// ТЕСТОВЫЙ сервер: повторяет поведение Go-бэкенда finOps по его исходникам
// (internal/service/planner.go, validator.go, middleware/auth.go, handler/health.go).
// В расширение не входит; нужен, чтобы проверять настоящие HTTP-запросы и разбор ответов.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export type PlannerReply =
  | { kind?: string; plan?: Record<string, any>; questions?: Array<Record<string, any>> }
  | { fail: 'provider' | 'persist' };

export interface Fake {
  url: string;
  requests: any[];
  setPlanner(fn: (req: any) => PlannerReply | Promise<PlannerReply>): void;
  close(): Promise<void>;
}

const isStr = (v: unknown) => typeof v === 'string';
const isInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v);
const strList = (v: unknown) => v === null || v === undefined || (Array.isArray(v) && v.every(isStr));
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

/** Имитация json.Decode в Go-структуры: тип поля обязан совпасть, лишние поля игнорируются. */
function goDecodeError(r: any): string | null {
  const bad = (cond: boolean) => !cond;
  if (typeof r !== 'object' || r === null) return 'not an object';
  if (bad(r.schemaVersion === undefined || isStr(r.schemaVersion))) return 'schemaVersion';
  if (bad(r.requestId === undefined || isStr(r.requestId))) return 'requestId';
  const e = r.epic ?? {};
  if (bad(e.text === undefined || isStr(e.text))) return 'epic.text';
  for (const k of ['acceptanceCriteria', 'constraints', 'nonGoals']) if (bad(strList(e[k]))) return `epic.${k}`;
  if (bad(r.preference === undefined || isStr(r.preference))) return 'preference';
  const pp = r.projectProfile ?? {};
  if (bad(strList(pp.stack)) || bad(pp.text === undefined || isStr(pp.text))) return 'projectProfile';
  for (const c of r.context ?? []) {
    if (bad(['id', 'path', 'contentHash', 'content'].every((k) => c[k] === undefined || isStr(c[k])))) return 'context';
    if (bad((c.startLine === undefined || isInt(c.startLine)) && (c.endLine === undefined || isInt(c.endLine)))) return 'context.lines';
  }
  for (const m of r.allowedModels ?? []) {
    if (bad(['id', 'displayName'].every((k) => m[k] === undefined || isStr(m[k])))) return 'allowedModels';
    if (bad(strList(m.params))) return 'allowedModels.params';
  }
  const f = r.catalog?.fetchedAt;
  if (f !== undefined && !(isStr(f) && /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(f))) return 'catalog.fetchedAt';
  for (const a of r.clarificationAnswers ?? []) {
    if (bad((a.id === undefined || isStr(a.id)) && (a.answer === undefined || isStr(a.answer)))) return 'clarificationAnswers';
  }
  return null;
}

/** Порт ValidatePlan из validator.go. */
function validatePlan(p: any, allowed: any[], ctx: any[]): string | null {
  if (!p) return 'plan is required';
  const tasks: any[] = p.tasks ?? [];
  if (tasks.length < 1 || tasks.length > 7) return 'tasks count must be between 1 and 7';
  const ids = new Set<string>();
  const models = new Set((allowed ?? []).map((m) => m.id));
  const refs = new Set<string>(['epic', ...(ctx ?? []).map((c) => c.id).filter(Boolean)]);
  for (const t of tasks) {
    if (!String(t.id ?? '').trim() || ids.has(t.id)) return 'task ids must be non-empty and unique';
    ids.add(t.id);
    if (!String(t.title ?? '').trim() || !String(t.goal ?? '').trim() || !(t.acceptanceCriteria ?? []).length) {
      return `task ${t.id} has missing required fields`;
    }
    if (t.recommendedModelId != null && !models.has(t.recommendedModelId)) {
      return `task ${t.id} recommends a model outside allowedModels`;
    }
    for (const r of t.contextRefs ?? []) if (!refs.has(r)) return `task ${t.id} references unknown context ${r}`;
  }
  const edges = new Map<string, string[]>();
  for (const t of tasks) {
    for (const d of t.dependsOn ?? []) {
      if (!ids.has(d) || d === t.id) return `task ${t.id} has invalid dependency ${d}`;
      edges.set(t.id, [...(edges.get(t.id) ?? []), d]);
    }
  }
  const state = new Map<string, number>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 1) return false;
    if (state.get(id) === 2) return true;
    state.set(id, 1);
    for (const d of edges.get(id) ?? []) if (!visit(d)) return false;
    state.set(id, 2);
    return true;
  };
  for (const id of ids) if (!visit(id)) return 'dependency cycle detected';
  return null;
}

/** Go отдаёт незаполненные срезы как null, а meta всегда целиком. */
function marshalResponse(reply: any, requestId: string, latencyMs: number) {
  const meta = {
    plannerModel: 'fake-llm', promptVersion: '1.0', policyVersion: '', latencyMs, providerCalls: 1,
    usage: { inputTokens: null, outputTokens: null }, cost: null,
  };
  const out: Record<string, unknown> = { schemaVersion: '1.0', requestId, kind: reply.kind ?? '' };
  if (reply.plan) {
    const p = reply.plan;
    out.plan = {
      id: p.id || randomUUID(), version: p.version || 1, summary: p.summary ?? '',
      assumptions: p.assumptions ?? null, warnings: p.warnings ?? null,
      tasks: (p.tasks ?? []).map((t: any) => ({
        id: t.id ?? '', title: t.title ?? '', goal: t.goal ?? '',
        expectedOutputs: t.expectedOutputs ?? null, acceptanceCriteria: t.acceptanceCriteria ?? null,
        dependsOn: t.dependsOn ?? null, contextRefs: t.contextRefs ?? null, assumptions: t.assumptions ?? null,
        risk: t.risk ?? '', recommendedModelId: t.recommendedModelId ?? null,
        recommendedParams: t.recommendedParams ?? null, recommendationReasons: t.recommendationReasons ?? null,
        recommendationSource: t.recommendationSource ?? '',
      })),
    };
  }
  if (reply.questions?.length) {
    out.questions = reply.questions.map((q: any) => ({ id: q.id ?? '', text: q.text ?? '', reason: q.reason ?? '' }));
  }
  out.meta = meta;
  return out;
}

export async function startFakeBackend(token: string, prefix = ''): Promise<Fake> {
  let planner: (req: any) => PlannerReply | Promise<PlannerReply> = () => ({ fail: 'provider' });
  const requests: any[] = [];

  const json = (res: http.ServerResponse, status: number, v: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(v) + '\n');
  };
  const err = (res: http.ServerResponse, status: number, code: string, message: string) =>
    json(res, status, { error: { code, message, retryable: status >= 500 } });

  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? '').split('?')[0]!.slice(prefix.length);
    if ((req.url ?? '').indexOf(prefix) !== 0) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return void res.end('404 page not found\n');
    }
    if (path === '/health' && req.method === 'GET') return json(res, 200, { status: 'ok' });

    if (path.startsWith('/v1/')) {
      const got = (req.headers.authorization ?? '').replace(/^Bearer /, '').trim();
      if (!got || got !== token) {
        // http.Error в Go: text/plain, но тело — JSON
        res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
        return void res.end('{"error":{"code":"AUTH_REQUIRED","message":"Bearer token required"}}\n');
      }
    }

    if (path === '/v1/capabilities' && req.method === 'GET') {
      return json(res, 200, {
        schemaVersion: '1.0',
        limits: { epicChars: 10000, otherChars: 6000, contextSources: 8, contextChars: 36000, requestBytes: 262144 },
        policyVersion: 'policy-v1',
      });
    }

    if (path === '/v1/plans' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        chunks.push(c as Buffer);
      }
      if (size > 262144) return err(res, 400, 'VALIDATION_ERROR', 'Invalid JSON request');
      let body: any;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return err(res, 400, 'VALIDATION_ERROR', 'Invalid JSON request');
      }
      const decodeErr = goDecodeError(body);
      if (decodeErr) return err(res, 400, 'VALIDATION_ERROR', 'Invalid JSON request');
      requests.push(body);

      const text = String(body.epic?.text ?? '').trim();
      if (!text || bytes(text) > 10000) return err(res, 400, 'VALIDATION_ERROR', 'Epic text is required and must not exceed 10000 characters');
      const other = [...(body.epic?.acceptanceCriteria ?? []), ...(body.epic?.constraints ?? []), ...(body.epic?.nonGoals ?? [])];
      if (other.reduce((n: number, v: string) => n + bytes(v), 0) > 6000) {
        return err(res, 400, 'VALIDATION_ERROR', 'Acceptance criteria, constraints and non-goals exceed 6000 characters');
      }
      if (!body.requestId) return err(res, 400, 'VALIDATION_ERROR', 'requestId is required');
      const pref = body.preference || 'balanced';
      if (!['balanced', 'quality', 'cost'].includes(pref)) return err(res, 400, 'VALIDATION_ERROR', 'Unknown preference');
      // колонка request_id в PostgreSQL имеет тип UUID
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.requestId)) {
        return err(res, 500, 'INTERNAL_ERROR', 'Could not persist plan response');
      }

      const started = Date.now();
      const reply = await planner(body);
      if ('fail' in reply) {
        return reply.fail === 'provider'
          ? err(res, 502, 'PROVIDER_UNAVAILABLE', 'Planner provider failed')
          : err(res, 500, 'INTERNAL_ERROR', 'Could not persist plan response');
      }
      if (reply.kind === 'plan') {
        const v = validatePlan(reply.plan, body.allowedModels, body.context);
        if (v) return err(res, 422, 'MODEL_OUTPUT_INVALID', v);
      }
      return json(res, 200, marshalResponse(reply, body.requestId, Date.now() - started));
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 page not found\n');
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}${prefix}`,
    requests,
    setPlanner: (fn) => void (planner = fn),
    close: () => new Promise<void>((r) => (server.closeAllConnections?.(), server.close(() => r()))),
  };
}

/** Типичный ответ LLM: опускает пустые поля, выбирает модели из переданного списка. */
export function llmLargePlan(req: any): PlannerReply {
  const allowed: string[] = (req.allowedModels ?? []).map((m: any) => m.id);
  const pick = (i: number) => (allowed.length ? allowed[Math.min(i, allowed.length - 1)] : null);
  const ctx: string[] = (req.context ?? []).map((c: any) => c.id);
  return {
    kind: 'plan',
    plan: {
      summary: 'Экспорт отчёта в PDF',
      assumptions: ['Библиотека PDF не выбрана'],
      tasks: [
        { id: 'S1', title: 'Согласовать контракт экспорта', goal: 'Определить формат выгрузки', expectedOutputs: ['Описание контракта'], acceptanceCriteria: ['Перечислены все поля'], risk: 'medium', recommendedModelId: pick(2), recommendationReasons: ['Нужно согласовать интерфейсы'] },
        { id: 'S2', title: 'Подготовка данных экспорта', goal: 'Функция подготовки строк', expectedOutputs: ['Чистая функция'], acceptanceCriteria: ['В результат попадают только выбранные строки'], dependsOn: ['S1'], contextRefs: ctx, risk: 'low', recommendedModelId: pick(0) },
        { id: 'S3', title: 'Генерация PDF', goal: 'Собрать PDF', expectedOutputs: ['Модуль PDF'], acceptanceCriteria: ['Файл открывается'], dependsOn: ['S2'], contextRefs: ['epic'], risk: 'medium', recommendedModelId: pick(1) },
        { id: 'S4', title: 'Кнопка экспорта', goal: 'Кнопка с состояниями', expectedOutputs: ['Компонент'], acceptanceCriteria: ['Кнопка недоступна при пустой выборке'], dependsOn: ['S3'], risk: 'low', recommendedModelId: pick(0) },
        { id: 'S5', title: 'Итоговая проверка', goal: 'Сквозной тест', expectedOutputs: ['Тест'], acceptanceCriteria: ['Существующая фильтрация работает'], dependsOn: ['S2', 'S3', 'S4'], risk: 'high', recommendedModelId: null },
      ],
    },
  };
}
