import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, interpretRaw } from '../webview/src/api';
import { fenceFor, mdEscape, planToJson, planToMarkdown, splitLines, taskToPrompt } from '../webview/src/format';
import * as P from '../webview/src/plan';
import type { ModelOption } from '../webview/src/protocol';
import { EMPTY_FORM, restoreState } from '../webview/src/state';
import { startFakeBackend, llmLargePlan, type Fake } from './helpers/fakeBackend';
import { FORM, MODELS, TOKEN, ask, expectPlan } from './helpers/flow';

let fake: Fake;
before(async () => {
  fake = await startFakeBackend(TOKEN);
  fake.setPlanner(llmLargePlan);
});
after(() => fake.close());

const fresh = async () => expectPlan((await ask(fake)).out);

// ---------- ответы в формате Go (null вместо пустых списков) ----------

const goTask = (over: Record<string, unknown> = {}) => ({
  id: 'S1', title: 'Контракт', goal: 'Согласовать', expectedOutputs: ['Описание'], acceptanceCriteria: ['Поля перечислены'],
  dependsOn: null, contextRefs: null, assumptions: null, risk: 'low', recommendedModelId: null,
  recommendedParams: null, recommendationReasons: null, recommendationSource: '', ...over,
});
const goMeta = { plannerModel: 'deepseek', promptVersion: '1.0', policyVersion: '', latencyMs: 4200, providerCalls: 1, usage: { inputTokens: null, outputTokens: null }, cost: null };
const goPlan = (tasks: unknown[], extra: Record<string, unknown> = {}) => ({
  schemaVersion: '1.0', requestId: 'r', kind: 'plan', meta: goMeta,
  plan: { id: 'p-1', version: 1, summary: 'Разбиение', assumptions: null, warnings: null, tasks, ...extra },
});
const CTX = { requestId: 'r', selectedModelIds: ['eco'], hasContext: false, hadAnswers: false };

test('Go: null вместо пустых массивов принимается как []', () => {
  const out = interpretRaw({ kind: 'http', status: 200, body: goPlan([goTask()]) }, CTX);
  assert.ok(out.ok && out.kind === 'plan');
  const t = out.plan.tasks[0]!;
  assert.deepEqual([t.dependsOn, t.contextRefs, t.assumptions, t.recommendationReasons], [[], [], [], []]);
  assert.equal(t.recommendationSource, undefined);
  assert.deepEqual(out.plan.assumptions, []);
});

test('Go: невыбранная модель в ответе отбрасывается с объяснением', () => {
  const out = interpretRaw({ kind: 'http', status: 200, body: goPlan([goTask({ recommendedModelId: 'ghost' })]) }, CTX);
  assert.ok(out.ok && out.kind === 'plan');
  assert.equal(out.plan.tasks[0]!.recommendedModelId, null);
  assert.ok(out.plan.tasks[0]!.recommendationReasons.includes(P.MODEL_DROPPED_REASON));
});

test('ответ без обязательных полей или с чужим requestId отклоняется', () => {
  const bad = interpretRaw({ kind: 'http', status: 200, body: { schemaVersion: '1.0', requestId: 'r', kind: 'plan', plan: { id: 'p', version: 1, tasks: [{ id: 'S1' }] } } }, CTX);
  assert.ok(!bad.ok && bad.error.code === 'MODEL_OUTPUT_INVALID' && bad.error.details.length > 0);
  const other = interpretRaw({ kind: 'http', status: 200, body: { ...goPlan([goTask()]), requestId: 'другой' } }, CTX);
  assert.ok(!other.ok && other.error.code === 'BAD_RESPONSE');
});

test('HTTP-ошибки без JSON-конверта: 413, 429, 5xx, неизвестный код', () => {
  const code = (status: number, body: unknown = null) => { const o = interpretRaw({ kind: 'http', status, body, retryAfter: status === 429 ? '30' : undefined }, CTX); return o.ok ? 'OK' : o.error; };
  const e429 = code(429); assert.ok(typeof e429 !== 'string' && e429.code === 'RATE_LIMITED' && /30/.test(e429.message));
  assert.ok(typeof code(413) !== 'string' && (code(413) as any).code === 'CONTEXT_TOO_LARGE');
  assert.ok((code(503, { unparsable: true }) as any).code === 'PROVIDER_UNAVAILABLE');
  assert.ok((code(418) as any).code === 'BAD_RESPONSE');
});

test('запрос соответствует контракту бэкенда и не содержит секретов', async () => {
  const req = await buildRequest({ requestId: 'r', form: { ...FORM, code: 'const a = 1;' }, preference: 'cost', models: MODELS.slice(0, 2), answers: [] });
  assert.equal(req.schemaVersion, '1.0');
  assert.equal(req.preference, 'cost');
  assert.match(req.context[0]!.contentHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(req.allowedModels.length, 2);
  assert.doesNotMatch(JSON.stringify(req), /api[_-]?key|bearer|token/i);
});

// ---------- редактирование плана ----------

test('зависимости: нельзя создать цикл, порядок строк не меняет связи', async () => {
  const p = await fresh();
  assert.equal(P.wouldCreateCycle(p.tasks, 'S1', 'S3'), true);
  assert.equal(P.wouldCreateCycle(p.tasks, 'S4', 'S1'), false);
  const moved = P.moveTask(p, 'S1', 1);
  assert.equal(moved.tasks[0]!.id, 'S2');
  assert.deepEqual(P.topoOrder(moved.tasks), ['S1', 'S2', 'S3', 'S4', 'S5']);
});

test('удаление шага с зависимыми блокируется, без зависимых — проходит', async () => {
  const p = await fresh();
  const blocked = P.removeTask(p, 'S2');
  assert.ok(!blocked.ok && blocked.blockedBy.includes('S3'));
  const ok = P.removeTask(p, 'S5');
  assert.ok(ok.ok && ok.plan.tasks.length === 4 && P.validatePlan(ok.plan.tasks).length === 0);
});

test('валидация ловит пустые поля и лишние шаги', async () => {
  const p = await fresh();
  const codes = P.validatePlan(P.addTask(p)!.plan.tasks).map((i) => i.code);
  assert.ok(codes.includes('EMPTY_FIELD') && codes.includes('NO_CRITERIA'));
  let big = p;
  while (big.tasks.length < 7) big = P.addTask(big)!.plan;
  assert.equal(P.addTask(big), null);
  assert.equal(P.nextTaskId(big.tasks), 'S8');
});

test('статусы: провал не открывает зависимые, правка принятого помечает зависимые на перепроверку', async () => {
  let p = await fresh();
  p = P.setStatus(p, 'S1', 'done');
  assert.deepEqual(P.unmetDependencies(p, p.tasks.find((t) => t.id === 'S2')!), []);
  p = P.setStatus(P.setStatus(p, 'S2', 'done'), 'S3', 'done');
  p = P.editTask(p, 'S1', { goal: 'Изменённая цель' });
  const by = (id: string) => p.tasks.find((t) => t.id === id)!;
  assert.equal(by('S1').status, 'todo');
  assert.equal(by('S2').needsRecheck, true);
  assert.equal(by('S3').needsRecheck, true);
  assert.equal(by('S5').needsRecheck, false);
  assert.equal(by('S1').recommendationStale, true);
  let q = await fresh();
  q = P.setStatus(q, 'S1', 'failed');
  assert.deepEqual(P.unmetDependencies(q, q.tasks.find((t) => t.id === 'S2')!), ['S1']);
});

test('ручной выбор модели снимает пометку устаревшей рекомендации', async () => {
  let p = P.editTask(await fresh(), 'S2', { title: 'Новое название' });
  assert.equal(p.tasks.find((t) => t.id === 'S2')!.recommendationStale, true);
  p = P.setModel(p, 'S2', 'pro');
  const t = p.tasks.find((t) => t.id === 'S2')!;
  assert.equal(t.recommendationStale, false);
  assert.equal(t.recommendationSource, 'user');
});

// ---------- копирование и экспорт ----------

test('текст задания: цель, критерии, ограничения, входы и явные неизвестные', async () => {
  const p = await fresh();
  const text = taskToPrompt(p, p.tasks.find((t) => t.id === 'S2')!, FORM);
  assert.match(text, /# Подзадача S2: Подготовка данных экспорта/);
  assert.match(text, /Цель эпика: Добавить экспорт отчёта в PDF/);
  assert.match(text, /Критерии готовности:\n- В результат попадают только выбранные строки/);
  assert.match(text, /Ограничения:\n- Не менять фильтрацию/);
  assert.match(text, /Входы от предыдущих шагов[\s\S]*- S1:/);
  assert.match(text, /Неизвестное:[\s\S]*Исходный код не предоставлен/);
  assert.match(text, /Критерии готовности всего эпика пользователь не задавал/);
});

test('фрагмент кода попадает в задание в безопасном ограждении, только в шаги со ссылкой на него', async () => {
  const code = 'const s = `a ``` b`;';
  assert.equal(fenceFor(code).length, 4);
  const form = { ...FORM, code };
  const p = expectPlan((await ask(fake, { form })).out); // у S2 ссылка ctx-1, у S3 только epic, у остальных пусто
  const prompt = (id: string) => taskToPrompt(p, p.tasks.find((t) => t.id === id)!, form);
  assert.ok(prompt('S2').includes('````\n' + code + '\n````'));
  assert.ok(!prompt('S3').includes(code)); // ссылка epic — это текст задачи, не код
  assert.ok(!prompt('S1').includes(code));
});

test('markdown и json экспорт', async () => {
  const p = await fresh();
  const md = planToMarkdown(p, FORM, MODELS, 'balanced');
  assert.match(md, /## S1\. /);
  assert.match(md, /Порядок исполнения:\*\* S1 → S2/);
  assert.match(md, /предварительно/i);
  const json = JSON.parse(planToJson(p, FORM, MODELS, ['eco', 'mid'], 'balanced'));
  assert.equal(json.schemaVersion, '1.0');
  assert.equal(json.plan.tasks.length, 5);
  assert.deepEqual(json.availableModels.map((m: ModelOption) => m.id), ['eco', 'mid']);
  assert.equal(json.plan.meta, undefined);
});

test('экранирование markdown и разбор строк', () => {
  assert.equal(mdEscape('a *b* [c]'), 'a \\*b\\* \\[c\\]');
  assert.equal(mdEscape('# заголовок'), '\\# заголовок');
  assert.deepEqual(splitLines('- один\n\n2. два\n  * три  '), ['один', 'два', 'три']);
});

test('восстановление состояния: мусор и старый формат → чистое состояние, валидное сохраняется', () => {
  assert.equal(restoreState(null).form.taskText, '');
  assert.equal(restoreState({ v: 1, form: { taskText: 'старое демо' } }).form.taskText, '');
  const s = restoreState({ v: 2, form: { taskText: 'abc' }, preference: 'quality', selectedModelIds: ['eco'] });
  assert.equal(s.form.taskText, 'abc');
  assert.equal(s.preference, 'quality');
  assert.deepEqual(restoreState({ v: 2, form: EMPTY_FORM }).selectedModelIds, null);
});
