import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HostCommand, HostConfig, ToWebview } from './protocol';
import { buildRequest, checkForm, interpretRaw, requestSize, type ApiError, type InterpretCtx } from './api';
import { createHost } from './host';
import { planToJson, planToMarkdown, taskToPrompt } from './format';
import { mockRequest } from './mock';
import * as P from './plan';
import { LIMITS } from './schema';
import { DEFAULT_STATE, restoreState, type FormState, type PersistedState, type Preference, type Scenario } from './state';
import { InputPanel } from './components/InputPanel';
import { ResultPanel } from './components/ResultPanel';
import type { TaskActions } from './components/TaskCard';

const host = createHost();
const WIDE_AT = 860;

type Phase = 'idle' | 'loading' | 'error';

interface Active {
  requestId: string;
  ctx: InterpretCtx;
  abort: AbortController;
  demo: boolean;
}

export default function App() {
  const [config, setConfig] = useState<HostConfig | null>(null);
  const [st, setSt] = useState<PersistedState>(DEFAULT_STATE);
  const [ready, setReady] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<ApiError | null>(null);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [toast, setToast] = useState<{ text: string; level: 'info' | 'error' } | null>(null);
  const [tab, setTab] = useState<'input' | 'result'>('input');
  const [wide, setWide] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const active = useRef<Active | null>(null);
  const lastAnswers = useRef<Array<{ questionId: string; answer: string }>>([]);
  const stRef = useRef(st);
  stRef.current = st;

  // ---------- производные значения ----------

  const models = config?.models ?? [];
  const selectedIds = useMemo(() => {
    const all = models.map((m) => m.id);
    return st.selectedModelIds ? st.selectedModelIds.filter((id) => all.includes(id)) : all;
  }, [models, st.selectedModelIds]);
  const demoEnabled = st.demo.enabled ?? config?.demoMode ?? true;
  const plan = st.plan;
  const issues = useMemo(
    () => (plan ? P.validatePlan(plan.tasks, { selectedModelIds: selectedIds }) : []),
    [plan, selectedIds],
  );

  // ---------- подключение к host ----------

  const showToast = useCallback((text: string, level: 'info' | 'error' = 'info') => setToast({ text, level }), []);

  useEffect(() => {
    const off = host.onMessage((m: ToWebview) => {
      switch (m.type) {
        case 'init':
          setConfig(m.config);
          setSt(restoreState(m.state));
          setReady(true);
          break;
        case 'config':
          setConfig(m.config);
          break;
        case 'plan.response':
          finish(m.requestId, m.result);
          break;
        case 'toast':
          showToast(m.text, m.level);
          break;
        case 'reset':
          setSt(DEFAULT_STATE);
          setPhase('idle');
          setError(null);
          setFormErrors([]);
          break;
      }
    });
    host.send({ type: 'ready' });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // сохранение черновика и плана (с задержкой, чтобы не писать на каждый символ)
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => host.send({ type: 'state.save', state: st }), 400);
    return () => clearTimeout(t);
  }, [st, ready]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.level === 'error' ? 5000 : 2600);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWide((e?.contentRect.width ?? 0) >= WIDE_AT));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready]); // до init рендерится заглушка без ref, поэтому подключаемся после готовности

  // ---------- запрос плана ----------

  function finish(requestId: string, raw: Parameters<typeof interpretRaw>[0]) {
    const a = active.current;
    if (!a || a.requestId !== requestId) return; // запоздавший или чужой ответ не трогает текущее состояние
    active.current = null;
    const out = interpretRaw(raw, a.ctx);
    if (out.ok && out.kind === 'plan') {
      setSt((s) => ({ ...s, plan: out.plan, pending: null }));
      setPhase('idle');
      setError(null);
    } else if (out.ok) {
      setSt((s) => ({ ...s, pending: { questions: out.questions, answers: {} } }));
      setPhase('idle');
      setError(null);
    } else if (out.cancelled) {
      setPhase('idle');
      setError(null);
      showToast('Запрос отменён, введённые данные сохранены');
    } else {
      setError(out.error);
      setPhase('error');
    }
  }

  async function run(answers: Array<{ questionId: string; answer: string }>) {
    if (!config || active.current) return;
    const current = stRef.current;
    const errs = checkForm(current.form);
    if (errs.length) {
      setFormErrors(errs);
      setTab('input');
      return;
    }
    setFormErrors([]);

    const requestId = crypto.randomUUID();
    const req = await buildRequest({
      requestId,
      form: current.form,
      preference: current.preference,
      models: config.models.filter((m) => selectedIds.includes(m.id)),
      answers,
    });
    lastAnswers.current = answers;
    setTab('result');

    if (requestSize(req) > LIMITS.requestBytes) {
      setError({
        code: 'CONTEXT_TOO_LARGE',
        message: 'Запрос превышает 256 КиБ. Сократите текст задачи или фрагмент кода.',
        retryable: false,
        details: [],
      });
      setPhase('error');
      return;
    }

    const abort = new AbortController();
    const demo = demoEnabled;
    active.current = {
      requestId,
      abort,
      demo,
      ctx: {
        requestId,
        selectedModelIds: selectedIds,
        hasContext: req.context.length > 0,
        hadAnswers: answers.length > 0,
        apiBaseUrl: config.apiBaseUrl,
      },
    };
    setPhase('loading');
    setError(null);

    if (demo) {
      const raw = await mockRequest(req, current.demo.scenario, abort.signal);
      finish(requestId, raw);
    } else {
      host.send({ type: 'plan.request', requestId, payload: req });
    }
  }

  function cancel() {
    const a = active.current;
    if (!a) return;
    a.abort.abort();
    if (!a.demo) host.send({ type: 'plan.cancel', requestId: a.requestId });
    finish(a.requestId, { kind: 'cancelled' });
  }

  // ---------- изменение состояния ----------

  const patchForm = (patch: Partial<FormState>) => setSt((s) => ({ ...s, form: { ...s.form, ...patch } }));
  const updatePlan = (fn: (p: P.UiPlan) => P.UiPlan) => setSt((s) => (s.plan ? { ...s, plan: fn(s.plan) } : s));

  const toggleModel = (id: string) =>
    setSt((s) => {
      const base = s.selectedModelIds ?? models.map((m) => m.id);
      return { ...s, selectedModelIds: base.includes(id) ? base.filter((x) => x !== id) : [...base, id] };
    });

  const actions: TaskActions = {
    edit: (id, patch) => updatePlan((p) => P.editTask(p, id, patch)),
    setModel: (id, modelId) => updatePlan((p) => P.setModel(p, id, modelId)),
    setStatus: (id, status, note) => updatePlan((p) => P.setStatus(p, id, status, note)),
    setNote: (id, note) => updatePlan((p) => P.setNote(p, id, note)),
    copy: (id) => {
      const s = stRef.current;
      const task = s.plan?.tasks.find((t) => t.id === id);
      if (!s.plan || !task) return;
      host.send({ type: 'clipboard.write', text: taskToPrompt(s.plan, task, s.form) });
      updatePlan((p) => P.markCopied(p, id));
      showToast(`Задание ${id} скопировано. Вставьте его в своего агента и выберите модель вручную.`);
    },
    remove: (id) => {
      const s = stRef.current;
      if (!s.plan) return false;
      const res = P.removeTask(s.plan, id);
      if (!res.ok) return false;
      updatePlan(() => res.plan);
      return true;
    },
    move: (id, delta) => updatePlan((p) => P.moveTask(p, id, delta)),
  };

  const exportPlan = (kind: 'md' | 'json') => {
    const s = stRef.current;
    if (!s.plan) return;
    const content =
      kind === 'md'
        ? planToMarkdown(s.plan, s.form, models, s.preference)
        : planToJson(s.plan, s.form, models, selectedIds, s.preference);
    host.send({ type: 'file.export', suggestedName: `plan.${kind}`, content, label: kind === 'md' ? 'Экспорт плана в Markdown' : 'Экспорт плана в JSON' });
  };

  const copyPlan = () => {
    const s = stRef.current;
    if (!s.plan) return;
    host.send({ type: 'clipboard.write', text: planToMarkdown(s.plan, s.form, models, s.preference) });
    showToast('План скопирован');
  };

  const addTask = (): string | null => {
    const s = stRef.current;
    if (!s.plan) return null;
    const res = P.addTask(s.plan);
    if (!res) return null;
    updatePlan(() => res.plan);
    return res.id;
  };

  const answerQuestion = (qid: string, text: string) =>
    setSt((s) => (s.pending ? { ...s, pending: { ...s.pending, answers: { ...s.pending.answers, [qid]: text } } } : s));

  const submitAnswers = (skip: boolean) => {
    const pending = stRef.current.pending;
    if (!pending) return;
    void run(pending.questions.map((q) => ({ questionId: q.id, answer: skip ? '' : (pending.answers[q.id] ?? '').trim() })));
  };

  const cmd = (name: HostCommand) => {
    setMenuOpen(false);
    host.send({ type: 'command', name });
  };

  if (!ready || !config) return <div className="boot">Загрузка…</div>;

  const inputPanel = (
    <InputPanel
      form={st.form}
      onForm={patchForm}
      models={models}
      selectedIds={selectedIds}
      onToggleModel={toggleModel}
      preference={st.preference}
      onPreference={(preference: Preference) => setSt((s) => ({ ...s, preference }))}
      demoEnabled={demoEnabled}
      onDemoEnabled={(enabled) => setSt((s) => ({ ...s, demo: { ...s.demo, enabled } }))}
      scenario={st.demo.scenario}
      onScenario={(scenario: Scenario) => setSt((s) => ({ ...s, demo: { ...s.demo, scenario } }))}
      loading={phase === 'loading'}
      errors={formErrors}
      hasPlan={Boolean(st.plan)}
      onSubmit={() => {
        setSt((s) => ({ ...s, pending: null }));
        void run([]);
      }}
    />
  );

  const resultPanel = (
    <ResultPanel
      phase={phase}
      error={error}
      pending={st.pending}
      plan={st.plan}
      models={models}
      selectedIds={selectedIds}
      issues={issues}
      actions={actions}
      onRetry={() => void run(lastAnswers.current)}
      onCancel={cancel}
      onAnswer={answerQuestion}
      onSubmitAnswers={() => submitAnswers(false)}
      onSkipAnswers={() => submitAnswers(true)}
      onCopyPlan={copyPlan}
      onExport={exportPlan}
      onAddTask={addTask}
    />
  );

  return (
    <div className={wide ? 'app wide' : 'app'} ref={rootRef}>
      <header className="topbar">
        <div className="brand">
          <strong>Декомпозитор задач</strong>
          {demoEnabled && <span className="chip demo" title="Ответы берутся из встроенных сценариев">Демо: без API</span>}
        </div>
        <div className="menu">
          <button type="button" className="btn ghost" aria-expanded={menuOpen} aria-haspopup="menu" onClick={() => setMenuOpen((v) => !v)}>⋯</button>
          {menuOpen && (
            <div className="menu-pop" role="menu">
              {config.runtime === 'vscode' && (
                <>
                  <button role="menuitem" type="button" onClick={() => cmd('openPanel')}>Открыть в редакторе (шире)</button>
                  <button role="menuitem" type="button" onClick={() => cmd('setToken')}>
                    {config.hasToken ? 'Сменить токен backend' : 'Задать токен backend'}
                  </button>
                  {config.hasToken && <button role="menuitem" type="button" onClick={() => cmd('clearToken')}>Удалить токен</button>}
                  <button role="menuitem" type="button" onClick={() => cmd('openSettings')}>Настройки (адрес, модели)</button>
                </>
              )}
              <button role="menuitem" type="button" onClick={() => cmd('resetData')}>Удалить сохранённые данные</button>
              <p className="menu-info">Backend: {config.apiBaseUrl}</p>
            </div>
          )}
        </div>
      </header>

      {!wide && (
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'input'} className={tab === 'input' ? 'tab active' : 'tab'} onClick={() => setTab('input')}>Задача</button>
          <button type="button" role="tab" aria-selected={tab === 'result'} className={tab === 'result' ? 'tab active' : 'tab'} onClick={() => setTab('result')}>
            План{st.plan ? ` (${st.plan.tasks.length})` : ''}
          </button>
        </div>
      )}

      <main className="layout">
        {(wide || tab === 'input') && <div className="pane">{inputPanel}</div>}
        {(wide || tab === 'result') && <div className="pane">{resultPanel}</div>}
      </main>

      <div className={`toast${toast ? ' show' : ''}${toast?.level === 'error' ? ' err' : ''}`} role="status" aria-live="polite">
        {toast?.text}
      </div>
    </div>
  );
}
