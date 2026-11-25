import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { checkBackend, normalizeBaseUrl, postPlan } from '../src/backend';
import { checkForm } from '../webview/src/api';
import { DEFAULT_MODELS } from '../webview/src/defaultModels';
import * as P from '../webview/src/plan';
import { startFakeBackend, llmLargePlan, type Fake } from './helpers/fakeBackend';
import { FORM, MODELS, TOKEN, ask, expectError, expectPlan } from './helpers/flow';

let fake: Fake;
before(async () => {
  fake = await startFakeBackend(TOKEN);
});
after(() => fake.close());

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });

// ---------- основной сценарий: крупная и простая задача ----------

test('крупная задача: запрос принимается бэкендом, план проходит проверку и приходит в интерфейс', async () => {
  fake.setPlanner(llmLargePlan);
  const { out, req } = await ask(fake, { form: { ...FORM, code: 'export const f = () => 1;' } });
  const plan = expectPlan(out);
  assert.equal(plan.tasks.length, 5);
  assert.deepEqual(P.validatePlan(plan.tasks, { selectedModelIds: MODELS.map((m) => m.id) }), []);
  assert.deepEqual(P.topoOrder(plan.tasks), ['S1', 'S2', 'S3', 'S4', 'S5']);
  // что реально получил бэкенд
  const got = fake.requests.at(-1);
  assert.equal(got.requestId, req.requestId);
  assert.equal(got.epic.text, FORM.taskText);
  assert.deepEqual(got.epic.constraints, ['Не менять фильтрацию']);
  assert.deepEqual(got.projectProfile.stack, ['TypeScript', 'React']);
  assert.equal(got.context[0].id, 'ctx-1');
  assert.ok(got.allowedModels.every((m: any) => Array.isArray(m.params) && m.params.every((p: unknown) => typeof p === 'string')));
  assert.ok(got.allowedModels[0].params.includes('tier: economy'));
  // meta от Go (usage с null) не мешает
  assert.equal(plan.meta?.plannerModel, 'fake-llm');
});

test('простая задача: одна подзадача', async () => {
  fake.setPlanner((req) => ({
    kind: 'plan',
    plan: { summary: 'Небольшая правка', tasks: [{ id: 'S1', title: 'Исправить', goal: 'Починить', expectedOutputs: ['Фикс'], acceptanceCriteria: ['Тест зелёный'], risk: 'low', recommendedModelId: req.allowedModels[0]?.id ?? null }] },
  }));
  const plan = expectPlan((await ask(fake)).out);
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0]!.recommendedModelId, 'eco');
});

test('рекомендуются только выбранные модели; без выбранных — без рекомендаций', async () => {
  fake.setPlanner(llmLargePlan);
  const two = expectPlan((await ask(fake, { selected: ['eco', 'mid'] })).out);
  assert.ok(two.tasks.every((t) => t.recommendedModelId === null || ['eco', 'mid'].includes(t.recommendedModelId)));
  const none = expectPlan((await ask(fake, { selected: [] })).out);
  assert.ok(none.tasks.every((t) => t.recommendedModelId === null));
  assert.deepEqual(fake.requests.at(-1).allowedModels, []);
});

test('уточнения: вопросы приходят, ответы уходят с id, затем план', async () => {
  let calls = 0;
  fake.setPlanner((req) => {
    calls++;
    return req.clarificationAnswers?.length
      ? llmLargePlan(req)
      : { kind: 'clarification', questions: [{ id: 'q1', text: 'Какой формат?', reason: 'нужно' }, { id: 'q2', text: 'Есть лимиты?' }] };
  });
  const first = (await ask(fake)).out;
  assert.ok(first.ok && first.kind === 'clarification' && first.questions.length === 2);
  const answers = first.ok && first.kind === 'clarification' ? first.questions.map((q) => ({ questionId: q.id, answer: 'A4' })) : [];
  expectPlan((await ask(fake, { answers })).out);
  assert.deepEqual(fake.requests.at(-1).clarificationAnswers, [
    { id: 'q1', questionId: 'q1', answer: 'A4' },
    { id: 'q2', questionId: 'q2', answer: 'A4' },
  ]);
  assert.equal(calls, 2);
});

test('повторные вопросы после ответов превращаются в понятную ошибку', async () => {
  fake.setPlanner(() => ({ kind: 'clarification', questions: [{ id: 'q1', text: 'Ещё?' }] }));
  const e = expectError((await ask(fake, { answers: [{ questionId: 'q1', answer: 'да' }] })).out);
  assert.equal(e.code, 'CLARIFICATION_LOOP');
});

test('реальные причуды LLM: риск с заглавной буквы, неизвестный риск, пустые вопросы без id', async () => {
  fake.setPlanner(() => ({
    kind: 'plan',
    plan: { tasks: [
      { id: 'S1', title: 'a', goal: 'b', expectedOutputs: ['x'], acceptanceCriteria: ['y'], risk: 'High' },
      { id: 'S2', title: 'a', goal: 'b', acceptanceCriteria: ['y'], risk: 'critical', dependsOn: ['S1'] },
    ] },
  }));
  const plan = expectPlan((await ask(fake)).out);
  assert.deepEqual(plan.tasks.map((t) => t.risk), ['high', 'medium']);
  assert.equal(plan.summary, '');
  // пустой «ожидаемый результат» не отклоняет план, а подсвечивается для правки
  assert.ok(P.validatePlan(plan.tasks).some((i) => i.code === 'EMPTY_FIELD' && i.taskId === 'S2'));

  fake.setPlanner(() => ({ kind: 'clarification', questions: [{ text: 'без id' }, { id: 'q1', text: 'раз' }, { id: 'q1', text: 'дубль' }] }));
  const q = (await ask(fake)).out;
  assert.ok(q.ok && q.kind === 'clarification');
  const ids = q.ok && q.kind === 'clarification' ? q.questions.map((x) => x.id) : [];
  assert.equal(new Set(ids).size, 3);
});

// ---------- ошибки: что видит пользователь ----------

test('ошибка API: недоступность LLM (502) — понятное сообщение, можно повторить', async () => {
  fake.setPlanner(() => ({ fail: 'provider' }));
  const e = expectError((await ask(fake)).out);
  assert.equal(e.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(e.retryable, true);
  assert.match(e.message, /LLM_API_KEY/);
});

test('ошибка сохранения в БД (500) — подсказка про базу и миграцию', async () => {
  fake.setPlanner(() => ({ fail: 'persist' }));
  const e = expectError((await ask(fake)).out);
  assert.equal(e.code, 'INTERNAL_ERROR');
  assert.match(e.message, /база данных/);
});

test('неверный токен: 401 с телом-JSON в text/plain разобран как AUTH_REQUIRED', async () => {
  fake.setPlanner(llmLargePlan);
  const e = expectError((await ask(fake, { token: 'wrong' })).out);
  assert.equal(e.code, 'AUTH_REQUIRED');
  assert.match(e.message, /токен/i);
  const noToken = expectError((await ask(fake, { token: '' })).out);
  assert.equal(noToken.code, 'AUTH_REQUIRED');
});

test('модель вышла за список моделей или дала цикл (422) — ошибка с причиной от сервера и повтором', async () => {
  fake.setPlanner((req) => {
    const p = llmLargePlan(req) as any;
    p.plan.tasks[1].recommendedModelId = 'gpt-unknown';
    return p;
  });
  const a = expectError((await ask(fake)).out);
  assert.equal(a.code, 'MODEL_OUTPUT_INVALID');
  assert.match(a.message, /outside allowedModels/);
  assert.equal(a.retryable, true);

  fake.setPlanner((req) => {
    const p = llmLargePlan(req) as any;
    p.plan.tasks[0].dependsOn = ['S5'];
    return p;
  });
  assert.match(expectError((await ask(fake)).out).message, /cycle/);
});

test('лимит бэкенда считается в БАЙТАХ: 6000 русских символов бэкенд отклоняет, фронтенд ловит заранее', async () => {
  const long = { ...FORM, taskText: 'я'.repeat(6000) };
  assert.equal(checkForm(long).length, 1);
  assert.match(checkForm(long)[0]!, /байт/);
  // доказательство, что лимит именно байтовый: прямой запрос бэкенд отклоняет
  fake.setPlanner(llmLargePlan);
  const e = expectError((await ask(fake, { form: long })).out);
  assert.equal(e.code, 'VALIDATION_ERROR');
  // 4900 символов = 9800 байт — проходит и там и там
  assert.equal(checkForm({ ...FORM, taskText: 'я'.repeat(4900) }).length, 0);
  expectPlan((await ask(fake, { form: { ...FORM, taskText: 'я'.repeat(4900) } })).out);
  // критерии/ограничения: 3000 символов кириллицы = 6000 байт
  assert.equal(checkForm({ ...FORM, criteria: 'я'.repeat(3001) }).length, 1);
});

test('сеть: сервер не запущен, таймаут и отмена', async () => {
  const port = await freePort();
  const down = expectError((await ask({ url: `http://127.0.0.1:${port}` })).out);
  assert.equal(down.code, 'NETWORK_ERROR');
  assert.equal(down.retryable, true);

  fake.setPlanner(() => new Promise((r) => setTimeout(() => r(llmLargePlan({})), 1500)));
  const slow = expectError((await ask(fake, { timeoutMs: 200 })).out);
  assert.equal(slow.code, 'CLIENT_TIMEOUT');

  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 100);
  const cancelled = (await ask(fake, { signal: ctrl.signal })).out;
  assert.ok(!cancelled.ok && cancelled.cancelled);
});

test('слишком большой запрос не отправляется', async () => {
  const raw = await postPlan({ base: fake.url, token: TOKEN, body: 'x'.repeat(262145), timeoutMs: 1000 });
  assert.equal(raw.kind, 'blocked');
});

// ---------- проверка соединения ----------

test('проверка соединения: все состояния', async () => {
  const ok = await checkBackend(fake.url, TOKEN);
  assert.equal(ok.state, 'ok');
  assert.ok(ok.state === 'ok' && ok.policyVersion === 'policy-v1' && ok.requestBytes === 262144);
  assert.equal((await checkBackend(fake.url, undefined)).state, 'no-token');
  assert.equal((await checkBackend(fake.url, 'wrong')).state, 'auth');
  assert.equal((await checkBackend(`http://127.0.0.1:${await freePort()}`, TOKEN)).state, 'down');
  assert.equal((await checkBackend('ftp://example.com', TOKEN)).state, 'bad-url');
  assert.equal((await checkBackend('http://example.com', TOKEN)).state, 'bad-url'); // http вне localhost запрещён
  assert.equal((await checkBackend('не адрес', TOKEN)).state, 'bad-url');
  const wrong = await checkBackend(`${fake.url}/неттут`, TOKEN); // отвечает не backend: 404
  assert.ok(wrong.state === 'down' && /HTTP 404/.test(wrong.message));
});

test('адрес backend: слэши, префикс пути, https', async () => {
  const n = (s: string) => { const r = normalizeBaseUrl(s); return r.ok ? r.base : r.message; };
  assert.equal(n('http://localhost:8080'), 'http://localhost:8080');
  assert.equal(n('http://localhost:8080/'), 'http://localhost:8080');
  assert.equal(n('  https://api.example.com/decomposer//  '), 'https://api.example.com/decomposer');
  assert.match(n('http://api.example.com'), /https/);
  const prefixed = await startFakeBackend(TOKEN, '/api');
  try {
    prefixed.setPlanner(llmLargePlan);
    expectPlan((await ask(prefixed)).out);
    assert.equal((await checkBackend(prefixed.url + '/', TOKEN)).state, 'ok');
  } finally {
    await prefixed.close();
  }
});

// ---------- конфигурация расширения ----------

test('package.json: нет демо-настройки, модели по умолчанию совпадают с кодом, адрес — порт бэкенда', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const props = pkg.contributes.configuration.properties;
  assert.equal(props['decomposer.demoMode'], undefined);
  assert.equal(props['decomposer.apiBaseUrl'].default, 'http://localhost:8080');
  assert.deepEqual(props['decomposer.models'].default, DEFAULT_MODELS);
  assert.equal(new Set(DEFAULT_MODELS.map((m) => m.id)).size, DEFAULT_MODELS.length);
});
