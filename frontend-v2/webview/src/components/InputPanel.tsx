import { useState } from 'react';
import type { BackendStatus, ModelOption } from '../protocol';
import { usage } from '../api';
import { LIMITS } from '../schema';
import { PREF_LABEL, TIER_LABEL } from '../format';
import type { FormState, Preference } from '../state';

interface Props {
  form: FormState;
  onForm: (patch: Partial<FormState>) => void;
  models: ModelOption[];
  selectedIds: string[];
  onToggleModel: (id: string) => void;
  preference: Preference;
  onPreference: (p: Preference) => void;
  status: BackendStatus | { state: 'checking' };
  apiBaseUrl: string;
  hasToken: boolean;
  onCheck: () => void;
  onSetToken: () => void;
  onOpenSettings: () => void;
  loading: boolean;
  errors: string[];
  hasPlan: boolean;
  onSubmit: () => void;
}

function ConnectionStrip(p: Pick<Props, 'status' | 'apiBaseUrl' | 'hasToken' | 'onCheck' | 'onSetToken' | 'onOpenSettings'>) {
  const s = p.status;
  let tone: 'ok' | 'warn' | 'bad' | 'wait' = 'wait';
  let text = 'Проверяю соединение…';
  let hint: string | null = null;
  if (s.state === 'ok') {
    tone = 'ok';
    text = 'Backend доступен, токен принят';
  } else if (s.state === 'no-token') {
    tone = 'warn';
    text = 'Backend доступен, но токен не задан';
  } else if (s.state === 'auth') {
    tone = 'bad';
    text = 'Backend не принял токен';
    hint = 'Токен должен совпадать со значением API_BEARER_TOKEN в .env бэкенда.';
  } else if (s.state === 'down') {
    tone = 'bad';
    text = 'Backend недоступен';
    hint = `${s.message} Запустите бэкенд командой go run ./cmd/api.`;
  } else if (s.state === 'bad-url') {
    tone = 'bad';
    text = 'Неверный адрес backend';
    hint = s.message;
  }
  return (
    <div className={`conn conn-${tone}`} role="status" aria-live="polite">
      <div className="conn-line">
        <span className="dot" aria-hidden="true" />
        <strong>{text}</strong>
      </div>
      {hint && <p className="hint">{hint}</p>}
      <p className="hint conn-url">{p.apiBaseUrl}</p>
      <div className="row gap wrap">
        <button type="button" className="btn" onClick={p.onSetToken}>{p.hasToken ? 'Сменить токен' : 'Задать токен'}</button>
        <button type="button" className="btn ghost" onClick={p.onCheck}>Проверить</button>
        <button type="button" className="btn ghost" onClick={p.onOpenSettings}>Адрес</button>
      </div>
    </div>
  );
}

function Counter({ value, max, unit = 'байт' }: { value: number; max: number; unit?: string }) {
  return (
    <span className={value > max ? 'count over' : 'count'} aria-label={`${value} из ${max} ${unit}`}>
      {value.toLocaleString('ru-RU')} / {max.toLocaleString('ru-RU')} {unit}
    </span>
  );
}

export function InputPanel(p: Props) {
  const [confirming, setConfirming] = useState(false);
  const { form } = p;
  const u = usage(form);

  const submit = () => {
    if (p.hasPlan && !confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    p.onSubmit();
  };

  return (
    <form
      className="panel input-panel"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h2 className="panel-title">Задача</h2>

      <ConnectionStrip status={p.status} apiBaseUrl={p.apiBaseUrl} hasToken={p.hasToken} onCheck={p.onCheck} onSetToken={p.onSetToken} onOpenSettings={p.onOpenSettings} />

      <div className="field">
        <div className="field-head">
          <label htmlFor="taskText">
            Полный текст задачи <span className="req" title="Обязательное поле">*</span>
          </label>
          <Counter value={u.task} max={LIMITS.taskBytes} />
        </div>
        <textarea
          id="taskText"
          rows={7}
          value={form.taskText}
          placeholder="Например: добавить экспорт отчёта в PDF с учётом текущих фильтров"
          onChange={(e) => p.onForm({ taskText: e.target.value })}
          aria-required="true"
        />
      </div>

      <div className="field">
        <div className="field-head">
          <label htmlFor="stack">Стек проекта</label>
          <span className="opt">необязательно</span>
        </div>
        <input
          id="stack"
          type="text"
          value={form.stack}
          placeholder="TypeScript, React, Node.js"
          onChange={(e) => p.onForm({ stack: e.target.value })}
        />
      </div>

      <div className="field">
        <div className="field-head">
          <label htmlFor="criteria">Критерии готовности</label>
          <span className="opt">по одному в строке</span>
        </div>
        <textarea
          id="criteria"
          rows={3}
          value={form.criteria}
          placeholder="Только выбранные строки попадают в отчёт"
          onChange={(e) => p.onForm({ criteria: e.target.value })}
        />
      </div>

      <div className="field">
        <div className="field-head">
          <label htmlFor="constraints">Ограничения</label>
          <span className="opt">по одному в строке</span>
        </div>
        <textarea
          id="constraints"
          rows={3}
          value={form.constraints}
          placeholder="Не менять существующую фильтрацию"
          onChange={(e) => p.onForm({ constraints: e.target.value })}
        />
        <div className="field-foot">
          <span className="hint">Критерии и ограничения вместе (кириллица = 2 байта на символ):</span>
          <Counter value={u.other} max={LIMITS.otherBytes} />
        </div>
      </div>

      <div className="field">
        <div className="field-head">
          <label htmlFor="code">Фрагмент кода</label>
          <Counter value={u.code} max={LIMITS.code} unit="симв." />
        </div>
        <textarea
          id="code"
          className="mono"
          rows={5}
          spellCheck={false}
          value={form.code}
          placeholder="Вставьте только нужные строки: сигнатуры, типы, пример теста"
          onChange={(e) => p.onForm({ code: e.target.value })}
        />
        <p className="hint">Уйдёт на backend вместе с задачей. Не вставляйте ключи, пароли и персональные данные.</p>
      </div>

      <fieldset className="field">
        <legend>Доступные модели</legend>
        <p className="hint">Рекомендации строятся только из отмеченных моделей.</p>
        <ul className="models">
          {p.models.map((m) => (
            <li key={m.id}>
              <label className="model-option" title={m.notes}>
                <input type="checkbox" checked={p.selectedIds.includes(m.id)} onChange={() => p.onToggleModel(m.id)} />
                <span className="model-name">{m.displayName}</span>
                <span className={`chip tier-${m.tier}`}>{TIER_LABEL[m.tier]}</span>
              </label>
            </li>
          ))}
        </ul>
        {p.selectedIds.length === 0 && (
          <p className="hint warn-text">Ни одна модель не отмечена: план будет составлен без рекомендаций.</p>
        )}
      </fieldset>

      <fieldset className="field">
        <legend>Что важнее при выборе модели</legend>
        <div className="segmented" role="radiogroup" aria-label="Предпочтение">
          {(Object.keys(PREF_LABEL) as Preference[]).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={p.preference === k}
              className={p.preference === k ? 'seg active' : 'seg'}
              onClick={() => p.onPreference(k)}
            >
              {PREF_LABEL[k]}
            </button>
          ))}
        </div>
      </fieldset>

      {p.errors.length > 0 && (
        <div className="notice error" role="alert">
          <ul>
            {p.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {confirming ? (
        <div className="notice warn" role="alertdialog" aria-label="Подтверждение замены плана">
          <p>Текущий план, включая ваши правки и отметки, будет заменён новым.</p>
          <div className="row gap">
            <button type="submit" className="btn primary">Заменить план</button>
            <button type="button" className="btn" onClick={() => setConfirming(false)}>Отмена</button>
          </div>
        </div>
      ) : (
        <button type="submit" className="btn primary wide" disabled={p.loading}>
          {p.loading ? 'Идёт разбиение…' : p.hasPlan ? 'Разбить заново' : 'Разбить задачу'}
        </button>
      )}
    </form>
  );
}
