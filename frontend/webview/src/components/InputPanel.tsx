import { useState } from 'react';
import type { ModelOption } from '../protocol';
import { LIMITS } from '../schema';
import { PREF_LABEL, TIER_LABEL } from '../format';
import { SCENARIO_LABEL } from '../mock';
import type { FormState, Preference, Scenario } from '../state';

interface Props {
  form: FormState;
  onForm: (patch: Partial<FormState>) => void;
  models: ModelOption[];
  selectedIds: string[];
  onToggleModel: (id: string) => void;
  preference: Preference;
  onPreference: (p: Preference) => void;
  demoEnabled: boolean;
  onDemoEnabled: (v: boolean) => void;
  scenario: Scenario;
  onScenario: (s: Scenario) => void;
  loading: boolean;
  errors: string[];
  hasPlan: boolean;
  onSubmit: () => void;
}

function Counter({ value, max }: { value: number; max: number }) {
  return (
    <span className={value > max ? 'count over' : 'count'} aria-label={`${value} из ${max} символов`}>
      {value.toLocaleString('ru-RU')} / {max.toLocaleString('ru-RU')}
    </span>
  );
}

export function InputPanel(p: Props) {
  const [confirming, setConfirming] = useState(false);
  const { form } = p;
  const extras = form.stack.length + form.constraints.length + form.criteria.length;

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

      <div className="field">
        <div className="field-head">
          <label htmlFor="taskText">
            Полный текст задачи <span className="req" title="Обязательное поле">*</span>
          </label>
          <Counter value={form.taskText.length} max={LIMITS.taskText} />
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
          <span className="hint">Стек, критерии и ограничения вместе:</span>
          <Counter value={extras} max={LIMITS.extras} />
        </div>
      </div>

      <div className="field">
        <div className="field-head">
          <label htmlFor="code">Фрагмент кода</label>
          <Counter value={form.code.length} max={LIMITS.code} />
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

      <div className="demo-box">
        <label className="switch">
          <input type="checkbox" checked={p.demoEnabled} onChange={(e) => p.onDemoEnabled(e.target.checked)} />
          <span>Демо: без API</span>
        </label>
        {p.demoEnabled ? (
          <div className="demo-scenario">
            <label htmlFor="scenario" className="hint">Сценарий демо-ответа</label>
            <select id="scenario" value={p.scenario} onChange={(e) => p.onScenario(e.target.value as Scenario)}>
              {(Object.keys(SCENARIO_LABEL) as Scenario[]).map((s) => (
                <option key={s} value={s}>
                  {SCENARIO_LABEL[s]}
                </option>
              ))}
            </select>
            <p className="hint">Ответы берутся из встроенных сценариев и не зависят от текста задачи. Backend не вызывается.</p>
          </div>
        ) : (
          <p className="hint">Запрос уйдёт на backend; LLM-ключ хранится только на сервере.</p>
        )}
      </div>

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
