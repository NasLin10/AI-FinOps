import { useEffect, useState } from 'react';
import type { ModelOption } from '../protocol';
import { RISK_LABEL, STATUS_LABEL, TIER_LABEL, joinLines, splitLines } from '../format';
import {
  directDependents,
  unmetDependencies,
  wouldCreateCycle,
  type Issue,
  type UiPlan,
  type UiTask,
} from '../plan';

export interface TaskActions {
  edit: (id: string, patch: Partial<Pick<UiTask, 'title' | 'goal' | 'expectedOutputs' | 'acceptanceCriteria' | 'risk' | 'dependsOn' | 'assumptions'>>) => void;
  setModel: (id: string, modelId: string | null) => void;
  setStatus: (id: string, status: 'todo' | 'done' | 'failed', note?: string) => void;
  setNote: (id: string, note: string) => void;
  copy: (id: string) => void;
  remove: (id: string) => boolean; // false — удаление заблокировано зависимостями
  move: (id: string, delta: -1 | 1) => void;
}

interface Props {
  plan: UiPlan;
  task: UiTask;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  models: ModelOption[];
  selectedIds: string[];
  issues: Issue[];
  actions: TaskActions;
}

/** Многострочное поле «пункт на строку»: локальный текст, чтобы можно было печатать пустые строки. */
function LinesField(props: { id: string; label: string; value: string[]; onChange: (v: string[]) => void; rows?: number; invalid?: boolean }) {
  const [text, setText] = useState(joinLines(props.value));
  useEffect(() => {
    if (joinLines(splitLines(text)) !== joinLines(props.value)) setText(joinLines(props.value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.value]);
  return (
    <div className="field">
      <label htmlFor={props.id}>{props.label}</label>
      <textarea
        id={props.id}
        rows={props.rows ?? 3}
        value={text}
        aria-invalid={props.invalid || undefined}
        onChange={(e) => {
          setText(e.target.value);
          props.onChange(splitLines(e.target.value));
        }}
      />
    </div>
  );
}

export function TaskCard({ plan, task, index, expanded, onToggle, models, selectedIds, issues, actions }: Props) {
  const [copyWarn, setCopyWarn] = useState(false);
  const [removeBlocked, setRemoveBlocked] = useState<string[] | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const uid = `t-${task.id}`;
  const unmet = unmetDependencies(plan, task);
  const mine = issues.filter((i) => i.taskId === task.id);
  const errors = mine.filter((i) => i.severity === 'error');
  const modelWarn = mine.find((i) => i.code === 'MODEL_NOT_SELECTED');
  const model = models.find((m) => m.id === task.recommendedModelId);
  const modelLabel = task.recommendedModelId ? (model?.displayName ?? task.recommendedModelId) : null;
  const others = plan.tasks.filter((t) => t.id !== task.id);
  const isLast = index === plan.tasks.length - 1;

  const doCopy = () => {
    if (unmet.length && !copyWarn) {
      setCopyWarn(true);
      return;
    }
    setCopyWarn(false);
    actions.copy(task.id);
  };

  const doRemove = () => {
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    setConfirmRemove(false);
    const ok = actions.remove(task.id);
    if (!ok) setRemoveBlocked(directDependents(plan.tasks, task.id));
  };

  return (
    <li className={`task status-${task.status}${errors.length ? ' invalid' : ''}`}>
      <button type="button" className="task-head" aria-expanded={expanded} aria-controls={`${uid}-body`} onClick={onToggle}>
        <span className="task-id">{task.id}</span>
        <span className="task-main">
          <span className="task-title">{task.title || <em>Без названия</em>}</span>
          <span className="task-goal">{task.goal || <em>Цель не заполнена</em>}</span>
          <span className="task-meta">
            <span className={`chip risk-${task.risk}`}>{RISK_LABEL[task.risk]}</span>
            {task.dependsOn.length > 0 && <span className="chip dep">← {task.dependsOn.join(', ')}</span>}
            <span className={`chip model${modelLabel ? '' : ' none'}`} title="Рекомендация предварительная">
              {modelLabel ?? 'модель не выбрана'}
              {modelLabel && <small> · предв.</small>}
            </span>
            <span className={`chip st-${task.status}`}>{STATUS_LABEL[task.status]}</span>
            {task.status === 'todo' && unmet.length > 0 && <span className="chip wait">ждёт {unmet.join(', ')}</span>}
            {task.needsRecheck && <span className="chip warn">требует перепроверки</span>}
            {errors.length > 0 && <span className="chip bad">есть ошибки</span>}
          </span>
        </span>
        <span className="chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className="task-body" id={`${uid}-body`}>
          {errors.length > 0 && (
            <div className="notice error" role="alert">
              <ul>{errors.map((e) => <li key={e.code + e.path}>{e.message}</li>)}</ul>
            </div>
          )}

          <div className="field">
            <label htmlFor={`${uid}-title`}>Название</label>
            <input id={`${uid}-title`} type="text" value={task.title} aria-invalid={!task.title.trim() || undefined} onChange={(e) => actions.edit(task.id, { title: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor={`${uid}-goal`}>Цель</label>
            <textarea id={`${uid}-goal`} rows={2} value={task.goal} aria-invalid={!task.goal.trim() || undefined} onChange={(e) => actions.edit(task.id, { goal: e.target.value })} />
          </div>
          <LinesField id={`${uid}-out`} label="Ожидаемый результат (по строке на пункт)" value={task.expectedOutputs} invalid={task.expectedOutputs.length === 0} onChange={(v) => actions.edit(task.id, { expectedOutputs: v })} />
          <LinesField id={`${uid}-crit`} label="Критерии готовности (по строке на пункт)" value={task.acceptanceCriteria} invalid={task.acceptanceCriteria.length === 0} onChange={(v) => actions.edit(task.id, { acceptanceCriteria: v })} />
          <LinesField id={`${uid}-ass`} label="Допущения и неизвестное (по строке на пункт)" value={task.assumptions} rows={2} onChange={(v) => actions.edit(task.id, { assumptions: v })} />

          <div className="field-row">
            <div className="field">
              <label htmlFor={`${uid}-risk`}>Риск</label>
              <select id={`${uid}-risk`} value={task.risk} onChange={(e) => actions.edit(task.id, { risk: e.target.value as UiTask['risk'] })}>
                {(Object.keys(RISK_LABEL) as Array<keyof typeof RISK_LABEL>).map((r) => (
                  <option key={r} value={r}>{RISK_LABEL[r]}</option>
                ))}
              </select>
            </div>
          </div>

          <fieldset className="field">
            <legend>Зависит от</legend>
            {others.length === 0 ? (
              <p className="hint">Других подзадач нет.</p>
            ) : (
              <div className="dep-list">
                {others.map((o) => {
                  const on = task.dependsOn.includes(o.id);
                  const blocked = !on && wouldCreateCycle(plan.tasks, task.id, o.id);
                  return (
                    <button
                      key={o.id}
                      type="button"
                      aria-pressed={on}
                      disabled={blocked}
                      title={blocked ? `${o.id} уже зависит от ${task.id}: связь создала бы цикл` : o.title}
                      className={on ? 'chip toggle on' : 'chip toggle'}
                      onClick={() => actions.edit(task.id, { dependsOn: on ? task.dependsOn.filter((d) => d !== o.id) : [...task.dependsOn, o.id] })}
                    >
                      {o.id}
                    </button>
                  );
                })}
              </div>
            )}
          </fieldset>

          <div className="reco">
            <div className="field">
              <label htmlFor={`${uid}-model`}>
                Рекомендуемая модель <span className="chip prelim">предварительно</span>
              </label>
              <select id={`${uid}-model`} value={task.recommendedModelId ?? ''} onChange={(e) => actions.setModel(task.id, e.target.value || null)}>
                <option value="">Не выбрана</option>
                {models
                  .filter((m) => selectedIds.includes(m.id) || m.id === task.recommendedModelId)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName} · {TIER_LABEL[m.tier]}
                      {selectedIds.includes(m.id) ? '' : ' (не отмечена)'}
                    </option>
                  ))}
              </select>
            </div>
            {task.recommendationSource === 'user' && <p className="hint">Выбрано вручную.</p>}
            {task.recommendationReasons.length > 0 && (
              <ul className="reasons">{task.recommendationReasons.map((r) => <li key={r}>{r}</li>)}</ul>
            )}
            {task.recommendationStale && (
              <p className="notice warn">Смысл шага изменён после рекомендации — она могла устареть. Проверьте выбор модели.</p>
            )}
            {modelWarn && <p className="notice warn">{modelWarn.message}</p>}
            {task.risk === 'high' && <p className="hint warn-text">Высокий риск: подтвердите модель вручную и проверьте результат внимательнее.</p>}
          </div>

          <div className="verdict">
            <h4>Результат выполнения</h4>
            <p className="hint">Отметка ставится вручную: «Подтверждено пользователем», а не автоматическая проверка.</p>
            <div className="field">
              <label htmlFor={`${uid}-note`}>Комментарий</label>
              <input id={`${uid}-note`} type="text" value={task.verdictNote} placeholder="Например: тесты зелёные, ссылка на diff" onChange={(e) => actions.setNote(task.id, e.target.value)} />
            </div>
            <div className="row gap wrap">
              <button type="button" className={task.status === 'done' ? 'btn active ok' : 'btn'} onClick={() => actions.setStatus(task.id, 'done')}>✓ Выполнена</button>
              <button type="button" className={task.status === 'failed' ? 'btn active bad' : 'btn'} onClick={() => actions.setStatus(task.id, 'failed')}>✕ Не выполнена</button>
              {(task.status === 'done' || task.status === 'failed') && (
                <button type="button" className="btn ghost" onClick={() => actions.setStatus(task.id, 'todo')}>Сбросить отметку</button>
              )}
            </div>
            {task.status === 'failed' && <p className="hint">Зависимые шаги не считаются готовыми, пока этот не выполнен.</p>}
          </div>

          {copyWarn && (
            <div className="notice warn" role="alertdialog" aria-label="Предупреждение о зависимостях">
              <p>Шаги {unmet.join(', ')} ещё не отмечены выполненными. Агент может не получить нужные входы.</p>
              <div className="row gap">
                <button type="button" className="btn primary" onClick={doCopy}>Скопировать всё равно</button>
                <button type="button" className="btn" onClick={() => setCopyWarn(false)}>Отмена</button>
              </div>
            </div>
          )}
          {removeBlocked && (
            <div className="notice error" role="alert">
              <p>Нельзя удалить {task.id}: от него зависят {removeBlocked.join(', ')}. Сначала уберите или переназначьте эти зависимости.</p>
              <button type="button" className="btn" onClick={() => setRemoveBlocked(null)}>Понятно</button>
            </div>
          )}
          {confirmRemove && !removeBlocked && (
            <div className="notice warn" role="alertdialog" aria-label="Подтверждение удаления">
              <p>Удалить подзадачу {task.id}?</p>
              <div className="row gap">
                <button type="button" className="btn bad" onClick={doRemove}>Удалить</button>
                <button type="button" className="btn" onClick={() => setConfirmRemove(false)}>Отмена</button>
              </div>
            </div>
          )}

          <div className="task-actions">
            <button type="button" className="btn primary" disabled={errors.length > 0} title={errors.length ? 'Исправьте ошибки в шаге' : undefined} onClick={doCopy}>
              Скопировать задание
            </button>
            <div className="row gap">
              <button type="button" className="btn icon" aria-label="Переместить выше" disabled={index === 0} onClick={() => actions.move(task.id, -1)}>↑</button>
              <button type="button" className="btn icon" aria-label="Переместить ниже" disabled={isLast} onClick={() => actions.move(task.id, 1)}>↓</button>
              <button type="button" className="btn ghost danger" onClick={doRemove}>Удалить</button>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}
