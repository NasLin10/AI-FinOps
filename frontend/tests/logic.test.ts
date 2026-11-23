import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, checkForm, interpretRaw } from '../webview/src/api';
import { fenceFor, mdEscape, planToJson, planToMarkdown, splitLines, taskToPrompt } from '../webview/src/format';
import { mockRequest } from '../webview/src/mock';
import * as P from '../webview/src/plan';
import type { ModelOption } from '../webview/src/protocol';
import type { Scenario } from '../webview/src/state';
import { EMPTY_FORM, restoreState, type FormState } from '../webview/src/state';

const MODELS: ModelOption[] = [
  { id: 'eco', displayName: 'Эко', tier: 'economy' },
  { id: 'mid', displayName: 'Баланс', tier: 'balanced' },
  { id: 'pro', displayName: 'Про', tier: 'premium' },
];
const FORM: FormState = { ...EMPTY_FORM, taskText: 'Добавить экспорт отчёта в PDF', stack: 'TypeScript, React', constraints: '- Не менять фильтрацию', criteria: '' };

async function run(scenario: Scenario, selected: string[], opts: { form?: FormState; answers?: Array<{ questionId: string; answer: string }>; pref?: 'balanced' | 'quality' | 'cost' } = {}) {
  const form = opts.form ?? FORM;
  const requestId = crypto.randomUUID();
  const answers = opts.answers ?? [];
  const req = await buildRequest({ requestId, form, preference: opts.pref ?? 'balanced', models: MODELS.filter((m) => selected.includes(m.id)), answers });
  const raw = await mockRequest(req, scenario, new AbortController().signal);
  return interpretRaw(raw, { requestId, selectedModelIds: selected, hasContext: req.context.length > 0, hadAnswers: answers.length > 0 });
}

function plan(out: Awaited<ReturnType<typeof run>>): P.UiPlan {
  assert.ok(out.ok && out.kind === 'plan', 'ожидался план');
  return out.plan;
}

// ---------- три сценария приёмки ----------

test('крупная задача: 3–5 валидных подзадач, зависимости корректны', async () => {
  const p = plan(await run('large', ['eco', 'mid', 'pro']));
  assert.ok(p.tasks.length >= 3 && p.tasks.length <= 5);
  assert.deepEqual(P.validatePlan(p.tasks), []);
  assert.deepEqual(P.topoOrder(p.tasks), ['S1', 'S2', 'S3', 'S4', 'S5']);
  assert.ok(p.tasks.every((t) => t.acceptanceCriteria.length > 0 && t.expectedOutputs.length > 0));
});

test('простая задача: одна подзадача', async () => {
  const p = plan(await run('simple', ['eco', 'mid']));
  assert.equal(p.tasks.length, 1);
});

test('ошибка API: понятная ошибка, повторяемая, без плана', async () => {
  const out = await run('error', ['eco']);
  assert.ok(!out.ok);
  assert.equal(out.error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(out.error.retryable, true);
  assert.equal(out.cancelled, false);
});

// ---------- рекомендации только из выбранных моделей ----------

test('рекомендуются только выбранные модели', async () => {
  for (const pref of ['balanced', 'quality', 'cost'] as const) {
    const p = plan(await run('large', ['eco', 'mid'], { pref }));
    for (const t of p.tasks) assert.ok(t.recommendedModelId === null || ['eco', 'mid'].includes(t.recommendedModelId), `${pref}: ${t.id}`);
  }
});

test('без выбранных моделей — рекомендации null с объяснением', async () => {
  const p = plan(await run('large', []));
  assert.ok(p.tasks.every((t) => t.recommendedModelId === null && t.recommendationReasons.length > 0));
});

test('невыбранная модель от backend отбрасывается', () => {
  const p = plan(interpretRaw({ kind: 'http', status: 200, body: { schemaVersion: '1.0', requestId: 'r', kind: 'plan', plan: {
    id: 'p', version: 1, summary: 's', assumptions: [], warnings: [], tasks: [{ id: 'S1', title: 't', goal: 'g', expectedOutputs: ['o'], acceptanceCriteria: ['c'], dependsOn: [], contextRefs: [], assumptions: [], risk: 'low', recommendedModelId: 'ghost', recommendedParams: [], recommendationReasons: [] }] } } },
    { requestId: 'r', selectedModelIds: ['eco'], hasContext: false, hadAnswers: false }));
  assert.equal(p.tasks[0]!.recommendedModelId, null);
  assert.ok(p.tasks[0]!.recommendationReasons.includes(P.MODEL_DROPPED_REASON));
});

test('предпочтение «Качество» не слабее «Стоимость»', async () => {
  const rank = { eco: 0, mid: 1, pro: 2 } as Record<string, number>;
  const score = (p: P.UiPlan) => p.tasks.reduce((s, t) => s + (t.recommendedModelId ? rank[t.recommendedModelId]! : 0), 0);
  const q = score(plan(await run('large', ['eco', 'mid', 'pro'], { pref: 'quality' })));
  const c = score(plan(await run('large', ['eco', 'mid', 'pro'], { pref: 'cost' })));
  assert.ok(q > c);
});

// ---------- валидация ответа ----------

test('цикл и несуществующая зависимость отклоняются как MODEL_OUTPUT_INVALID', async () => {
  const out = await run('invalid', ['eco', 'mid', 'pro']);
  assert.ok(!out.ok);
  assert.equal(out.error.code, 'MODEL_OUTPUT_INVALID');
  const codes = out.error.details.map((d) => d.code);
  assert.ok(codes.includes('CYCLE'));
  assert.ok(codes.includes('MISSING_DEPENDENCY'));
});

test('ответ без обязательных полей отклоняется со списком путей', () => {
  const out = interpretRaw({ kind: 'http', status: 200, body: { schemaVersion: '1.0', requestId: 'r', kind: 'plan', plan: { id: 'p', version: 1, summary: 's', tasks: [{ id: 'S1' }] } } },
    { requestId: 'r', selectedModelIds: [], hasContext: false, hadAnswers: false });
  assert.ok(!out.ok && out.error.code === 'MODEL_OUTPUT_INVALID' && out.error.details.length > 0);
});

test('ответ на чужой requestId игнорируется', async () => {
  const requestId = 'mine';
  const req = await buildRequest({ requestId: 'other', form: FORM, preference: 'balanced', models: MODELS, answers: [] });
  const raw = await mockRequest(req, 'simple', new AbortController().signal);
  const out = interpretRaw(raw, { requestId, selectedModelIds: [], hasContext: false, hadAnswers: false });
  assert.ok(!out.ok && out.error.code === 'BAD_RESPONSE');
});

test('уточнения: один раунд, второй вопрос превращается в ошибку', async () => {
  const first = await run('clarification', ['eco']);
  assert.ok(first.ok && first.kind === 'clarification' && first.questions.length <= 3);
  const answers = first.ok && first.kind === 'clarification' ? first.questions.map((q) => ({ questionId: q.id, answer: 'да' })) : [];
  assert.ok((await run('clarification', ['eco'], { answers })).ok);
  const loop = interpretRaw({ kind: 'http', status: 200, body: { schemaVersion: '1.0', requestId: 'r', kind: 'clarification', questions: [{ id: 'q', text: 'ещё?' }] } },
    { requestId: 'r', selectedModelIds: [], hasContext: false, hadAnswers: true });
  assert.ok(!loop.ok && loop.error.code === 'CLARIFICATION_LOOP');
});

test('сетевые исходы: таймаут, обрыв, отмена, 429, 401, 413', () => {
  const ctx = { requestId: 'r', selectedModelIds: [], hasContext: false, hadAnswers: false };
  const code = (raw: Parameters<typeof interpretRaw>[0]) => { const o = interpretRaw(raw, ctx); return o.ok ? 'OK' : o.error.code; };
  assert.equal(code({ kind: 'timeout' }), 'CLIENT_TIMEOUT');
  assert.equal(code({ kind: 'network', message: 'ECONNREFUSED' }), 'NETWORK_ERROR');
  assert.equal(code({ kind: 'cancelled' }), 'CANCELLED');
  assert.equal(code({ kind: 'http', status: 429, retryAfter: '30', body: null }), 'RATE_LIMITED');
  assert.equal(code({ kind: 'http', status: 401, body: null }), 'AUTH_REQUIRED');
  assert.equal(code({ kind: 'http', status: 413, body: null }), 'CONTEXT_TOO_LARGE');
  const o = interpretRaw({ kind: 'cancelled' }, ctx);
  assert.ok(!o.ok && o.cancelled);
});

// ---------- форма ----------

test('проверка формы: пусто, пробелы, слишком длинно', () => {
  assert.equal(checkForm(EMPTY_FORM).length, 1);
  assert.equal(checkForm({ ...EMPTY_FORM, taskText: '   \n ' }).length, 1);
  assert.equal(checkForm({ ...EMPTY_FORM, taskText: 'x'.repeat(10_001) }).length, 1);
  assert.equal(checkForm(FORM).length, 0);
});

test('запрос соответствует контракту 10.1 и не содержит секретов', async () => {
  const req = await buildRequest({ requestId: 'r', form: { ...FORM, code: 'const a = 1;' }, preference: 'cost', models: MODELS.slice(0, 2), answers: [] });
  assert.equal(req.schemaVersion, '1.0');
  assert.equal(req.preference, 'cost');
  assert.deepEqual(req.epic.constraints, ['Не менять фильтрацию']);
  assert.deepEqual(req.projectProfile.stack, ['TypeScript', 'React']);
  assert.equal(req.context[0]!.id, 'ctx-1');
  assert.match(req.context[0]!.contentHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(req.allowedModels.length, 2);
  assert.doesNotMatch(JSON.stringify(req), /api[_-]?key|bearer/i);
});

// ---------- редактирование плана ----------

const fresh = async () => plan(await run('large', ['eco', 'mid', 'pro']));

test('зависимости: нельзя создать цикл, порядок строк не меняет связи', async () => {
  const p = await fresh();
  assert.equal(P.wouldCreateCycle(p.tasks, 'S1', 'S3'), true);
  assert.equal(P.wouldCreateCycle(p.tasks, 'S4', 'S1'), false);
  const moved = P.moveTask(p, 'S1', 1);
  assert.equal(moved.tasks[0]!.id, 'S2');
  assert.deepEqual(moved.tasks.find((t) => t.id === 'S3')!.dependsOn, ['S2']);
  assert.deepEqual(P.topoOrder(moved.tasks), ['S1', 'S2', 'S3', 'S4', 'S5']);
});

test('удаление шага с зависимыми блокируется, без зависимых — проходит', async () => {
  const p = await fresh();
  const blocked = P.removeTask(p, 'S2');
  assert.ok(!blocked.ok && blocked.blockedBy.includes('S3'));
  const ok = P.removeTask(p, 'S5');
  assert.ok(ok.ok && ok.plan.tasks.length === 4 && P.validatePlan(ok.plan.tasks).length === 0);
});

test('валидация ловит пустые поля, отсутствие критериев и лишние шаги', async () => {
  const p = await fresh();
  const added = P.addTask(p)!;
  const codes = P.validatePlan(added.plan.tasks).map((i) => i.code);
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
  p = P.setStatus(p, 'S2', 'done');
  p = P.setStatus(p, 'S3', 'done');
  p = P.editTask(p, 'S1', { goal: 'Изменённая цель' });
  const by = (id: string) => p.tasks.find((t) => t.id === id)!;
  assert.equal(by('S1').status, 'todo');
  assert.equal(by('S2').needsRecheck, true);
  assert.equal(by('S3').needsRecheck, true);
  assert.equal(by('S5').needsRecheck, false); // S5 не был принят
  assert.equal(by('S1').recommendationStale, true);

  let q = await fresh();
  q = P.setStatus(q, 'S1', 'failed');
  assert.deepEqual(P.unmetDependencies(q, q.tasks.find((t) => t.id === 'S2')!), ['S1']);
});

test('ручной выбор модели снимает пометку устаревшей рекомендации', async () => {
  let p = await fresh();
  p = P.editTask(p, 'S2', { title: 'Новое название' });
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
  assert.doesNotMatch(text, /model-|Эко|Про\b/); // модель в текст задания не входит
});

test('фрагмент кода попадает в задание в безопасном ограждении', async () => {
  const code = 'const s = `a ``` b`;';
  assert.equal(fenceFor(code).length, 4);
  const p = await fresh();
  const text = taskToPrompt(p, p.tasks[0]!, { ...FORM, code });
  assert.ok(text.includes('````\n' + code + '\n````'));
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

test('восстановление состояния: мусор → чистое состояние, валидное сохраняется', () => {
  assert.equal(restoreState(null).form.taskText, '');
  assert.equal(restoreState({ v: 2 }).form.taskText, '');
  const s = restoreState({ v: 1, form: { taskText: 'abc' }, preference: 'quality', selectedModelIds: ['eco'], demo: { enabled: false, scenario: 'bad' } });
  assert.equal(s.form.taskText, 'abc');
  assert.equal(s.preference, 'quality');
  assert.equal(s.demo.scenario, 'large');
  assert.equal(s.demo.enabled, false);
});
