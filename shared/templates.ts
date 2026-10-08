import type {ISOTime, Weekday} from './types.ts';

// Habit challenges that trend on TikTok, adapted into daily habits.

export interface HabitTemplate {
  name: string;
  emoji: string;
  time?: ISOTime;
  durationMin?: number;
  days?: Weekday[];
}

export interface Challenge {
  id: string;
  title: string;
  emoji: string;
  description: string;
  habits: HabitTemplate[];
}

export const EVERY_DAY: Weekday[] = [0, 1, 2, 3, 4, 5, 6];
export const WEEKDAYS: Weekday[] = [1, 2, 3, 4, 5];

export const CHALLENGES: Challenge[] = [
  {
    id: '75-hard',
    title: '75 Hard',
    emoji: '🔥',
    description: '75 дней без пропусков: две тренировки, вода, чтение, питание.',
    habits: [
      {name: 'Тренировка 45 мин', emoji: '🏋️', time: '07:00', durationMin: 45},
      {name: 'Тренировка на улице 45 мин', emoji: '🌳', time: '18:00', durationMin: 45},
      {name: '3,7 л воды', emoji: '💧'},
      {name: '10 страниц нон-фикшн', emoji: '📖', time: '21:30', durationMin: 20},
      {name: 'Питание по плану, без алкоголя', emoji: '🥗'},
      {name: 'Фото прогресса', emoji: '📸'},
    ],
  },
  {
    id: 'that-girl',
    title: 'That Girl утро',
    emoji: '✨',
    description: 'Спокойное продуктивное утро: вода, движение, журнал, уход.',
    habits: [
      {name: 'Подъём без телефона', emoji: '🌅', time: '06:30', durationMin: 10},
      {name: 'Стакан воды с лимоном', emoji: '🍋', time: '06:40', durationMin: 5},
      {name: 'Йога или растяжка', emoji: '🧘', time: '06:45', durationMin: 15},
      {name: 'Журнал и план дня', emoji: '📓', time: '07:00', durationMin: 10},
      {name: 'Уход за кожей', emoji: '🧴', time: '07:10', durationMin: 10},
    ],
  },
  {
    id: '5am-club',
    title: '5 AM Club',
    emoji: '⏰',
    description: 'Правило 20/20/20: движение, рефлексия, развитие до 6 утра.',
    habits: [
      {name: 'Подъём в 5:00', emoji: '⏰', time: '05:00', durationMin: 5, days: WEEKDAYS},
      {name: '20 мин интенсивного движения', emoji: '🏃', time: '05:05', durationMin: 20, days: WEEKDAYS},
      {name: '20 мин рефлексии', emoji: '🧠', time: '05:25', durationMin: 20, days: WEEKDAYS},
      {name: '20 мин обучения', emoji: '🎧', time: '05:45', durationMin: 20, days: WEEKDAYS},
    ],
  },
  {
    id: '12-3-30',
    title: '12-3-30',
    emoji: '🚶',
    description: 'Беговая дорожка: наклон 12, скорость 3 мили/ч, 30 минут.',
    habits: [
      {name: 'Ходьба 12-3-30', emoji: '🚶', time: '19:00', durationMin: 30, days: [1, 3, 5]},
    ],
  },
  {
    id: 'hot-girl-walk',
    title: 'Hot Girl Walk',
    emoji: '💅',
    description: 'Прогулка 6 км с мыслями о благодарности, целях и себе.',
    habits: [{name: 'Прогулка 6 км', emoji: '💅', time: '08:00', durationMin: 60}],
  },
  {
    id: 'monk-mode',
    title: 'Monk Mode',
    emoji: '🧘‍♂️',
    description: 'Фокус без отвлечений: глубокая работа, без соцсетей, сон.',
    habits: [
      {name: 'Глубокая работа 2 часа', emoji: '🎯', time: '09:00', durationMin: 120, days: WEEKDAYS},
      {name: 'Без соцсетей до 18:00', emoji: '📵'},
      {name: 'Медитация 10 мин', emoji: '🕯️', time: '07:30', durationMin: 10},
      {name: 'Отбой до 23:00', emoji: '😴', time: '22:45', durationMin: 15},
    ],
  },
];
