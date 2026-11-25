import type { ModelOption } from './protocol';

/**
 * Модели, из которых пользователь выбирает «доступные ему» в своём coding-агенте.
 * Рекомендации плана строятся только из отмеченных. Список редактируется в настройке
 * `decomposer.models`; значения по умолчанию в package.json должны совпадать с этими
 * (это проверяет тест).
 */
export const DEFAULT_MODELS: ModelOption[] = [
  {
    id: 'claude-haiku-5-5',
    displayName: 'Claude Haiku 5.5',
    tier: 'economy',
    notes: 'Самая быстрая и дешёвая. Для небольших, чётко очерченных правок.',
  },
  {
    id: 'claude-sonnet-5-5',
    displayName: 'Claude Sonnet 5.5',
    tier: 'balanced',
    notes: 'Баланс цены и качества. Для типовых задач в одном-двух модулях.',
  },
  {
    id: 'claude-opus-5-5',
    displayName: 'Claude Opus 5.5',
    tier: 'premium',
    notes: 'Сильный reasoning. Для архитектуры, интеграции и рискованных мест.',
  },
];
