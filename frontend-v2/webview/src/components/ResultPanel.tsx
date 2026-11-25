import { useEffect, useState } from 'react';
import type { ModelOption } from '../protocol';
import { ERROR_TITLES, type ApiError } from '../api';
import { hasErrors, topoOrder, type Issue, type UiPlan } from '../plan';
import type { PendingClarification } from '../state';
import { TaskCard, type TaskActions } from './TaskCard';

interface Props {
  phase: 'idle' | 'loading' | 'error';
  error: ApiError | null;
  pending: PendingClarification | null;
  plan: UiPlan | null;
  models: ModelOption[];
  selectedIds: string[];
  issues: Issue[];
  actions: TaskActions;
  onRetry: () => void;
  onCancel: () => void;
  onAnswer: (questionId: string, text: string) => void;
  onSubmitAnswers: () => void;
  onSkipAnswers: () => void;
  onCopyPlan: () => void;
  onExport: (kind: 'md' | 'json') => void;
  onAddTask: () => string | null;
}

function EmptyState() {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden="true">⌥</div>
      <h3>Здесь появится план</h3>
      <ol>
        <li>Опишите задачу слева.</li>
        <li>Отметьте модели, которые у вас доступны.</li>
        <li>Нажмите «Разбить задачу» — получите 3–5 подзадач.</li>
        <li>Поправьте план и скопируйте задание для агента.</li>
      </ol>
    </div>
  );
}

function Loading({ onCancel }: { onCancel: () => void }) {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSec((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="loading" role="status" aria-live="polite">
      <div className="spinner" aria-hidden="true" />
      <h3>Разбиваем задачу…</h3>
      <p className="hint">Прошло {sec} с. Обычно это занимает до минуты.</p>
      <div className="skeletons" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div className="skeleton" key={i} />
        ))}
      </div>
      <button type="button" className="btn" onClick={onCancel}>Отменить</button>
    </div>
  );
}

function ErrorCard({ error, onRetry, hasPlan }: { error: ApiError; onRetry: () => void; hasPlan: boolean }) {
  return (
    <div className="notice error error-card" role="alert">
      <h3>{ERROR_TITLES[error.code] ?? 'Не удалось получить план'}</h3>
      <p>{error.message}</p>
      {error.details.length > 0 && (
        <ul className="details">
          {error.details.map((d, i) => (
            <li key={i}>
              {d.path && <code>{d.path}</code>} {d.message ?? d.code}
            </li>
          ))}
        </ul>
      )}
      <p className="hint">
        Введённые данные сохранены{hasPlan ? ', предыдущий план остался ниже' : ''}. Повтор запускается только вручную.
        {error.code && <> Код: <code>{error.code}</code>.</>}
      </p>
      <button type="button" className="btn primary" onClick={onRetry}>Повторить</button>
    </div>
  );
}

function Clarification(props: Pick<Props, 'pending' | 'onAnswer' | 'onSubmitAnswers' | 'onSkipAnswers'>) {
  const pending = props.pending!;
  return (
    <div className="clarify">
      <h3>Нужны уточнения</h3>
      <p className="hint">Модель задала до трёх вопросов. Ответьте на те, что знаете, остальные можно оставить пустыми — они попадут в план как допущения. Дополнительных раундов не будет.</p>
      {pending.questions.map((q, i) => (
        <div className="field" key={q.id}>
          <label htmlFor={`q-${q.id}`}>{i + 1}. {q.text}</label>
          {q.reason && <span className="hint">Зачем: {q.reason}</span>}
          <textarea id={`q-${q.id}`} rows={2} value={pending.answers[q.id] ?? ''} onChange={(e) => props.onAnswer(q.id, e.target.value)} />
        </div>
      ))}
      <div className="row gap wrap">
        <button type="button" className="btn primary" onClick={props.onSubmitAnswers}>Ответить и продолжить</button>
        <button type="button" className="btn" onClick={props.onSkipAnswers}>Пропустить, продолжить с допущениями</button>
      </div>
    </div>
  );
}

function PlanView(props: Props & { plan: UiPlan }) {
  const { plan, issues } = props;
  const [open, setOpen] = useState<Set<string>>(new Set());
  const order = topoOrder(plan.tasks);
  const blocking = hasErrors(issues);
  const globalIssues = issues.filter((i) => i.severity === 'error' && !i.taskId);
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const add = () => {
    const id = props.onAddTask();
    if (id) setOpen((s) => new Set(s).add(id));
  };

  return (
    <div className="plan">
      <header className="plan-head">
        <div className="row between wrap">
          <h2 className="panel-title">План · {plan.tasks.length} {plan.tasks.length === 1 ? 'подзадача' : plan.tasks.length < 5 ? 'подзадачи' : 'подзадач'}</h2>
        </div>
        {plan.summary && <p className="plan-summary">{plan.summary}</p>}
        {order && plan.tasks.length > 1 && (
          <p className="order"><span className="hint">Порядок исполнения:</span> {order.join(' → ')}</p>
        )}
        <p className="hint">Рекомендации моделей предварительные: окончательный выбор за вами.</p>
        {plan.warnings.length > 0 && (
          <div className="notice warn">
            <ul>{plan.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          </div>
        )}
        {plan.assumptions.length > 0 && (
          <details className="assumptions">
            <summary>Допущения плана ({plan.assumptions.length})</summary>
            <ul>{plan.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
          </details>
        )}
        {plan.meta && (plan.meta.providerCalls !== undefined || plan.meta.latencyMs) && (
          <p className="hint">
            {plan.meta.providerCalls !== undefined && <>Вызовов провайдера: {plan.meta.providerCalls}. </>}
            {plan.meta.latencyMs ? <>Время ответа: {(plan.meta.latencyMs / 1000).toFixed(1)} с. </> : null}
            {plan.meta.usage?.inputTokens != null && <>Токены: {plan.meta.usage.inputTokens} → {plan.meta.usage.outputTokens ?? '?'}.</>}
          </p>
        )}
      </header>

      <div className="toolbar" role="toolbar" aria-label="Действия с планом">
        <button type="button" className="btn primary" disabled={blocking} onClick={props.onCopyPlan}>Копировать весь план</button>
        <button type="button" className="btn" disabled={blocking} onClick={() => props.onExport('md')}>Экспорт .md</button>
        <button type="button" className="btn" disabled={blocking} onClick={() => props.onExport('json')}>Экспорт .json</button>
        <button type="button" className="btn ghost" disabled={plan.tasks.length >= 7} title={plan.tasks.length >= 7 ? 'Максимум 7 подзадач' : undefined} onClick={add}>+ Подзадача</button>
      </div>

      {blocking && (
        <div className="notice error" role="alert">
          <p><strong>План содержит ошибки</strong> — экспорт и копирование всего плана заблокированы, пока они не исправлены.</p>
          {globalIssues.length > 0 && <ul>{globalIssues.map((i) => <li key={i.code + i.path}>{i.message}</li>)}</ul>}
        </div>
      )}

      <ol className="tasks">
        {plan.tasks.map((t, i) => (
          <TaskCard
            key={t.id}
            plan={plan}
            task={t}
            index={i}
            expanded={open.has(t.id)}
            onToggle={() => toggle(t.id)}
            models={props.models}
            selectedIds={props.selectedIds}
            issues={issues}
            actions={props.actions}
          />
        ))}
      </ol>
    </div>
  );
}

export function ResultPanel(props: Props) {
  const { phase, error, pending, plan } = props;
  if (phase === 'loading') return <section className="panel result-panel"><Loading onCancel={props.onCancel} /></section>;

  return (
    <section className="panel result-panel" aria-live="polite">
      {phase === 'error' && error && <ErrorCard error={error} onRetry={props.onRetry} hasPlan={Boolean(plan)} />}
      {pending ? (
        <Clarification pending={pending} onAnswer={props.onAnswer} onSubmitAnswers={props.onSubmitAnswers} onSkipAnswers={props.onSkipAnswers} />
      ) : plan ? (
        <PlanView {...props} plan={plan} />
      ) : phase === 'idle' || !error ? (
        <EmptyState />
      ) : null}
    </section>
  );
}
