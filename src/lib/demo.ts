import {addDays, toISODate} from '../../shared/dates.ts';
import {setCheck, upsertHabit, upsertTask} from '../../shared/state.ts';
import {CHALLENGES, EVERY_DAY} from '../../shared/templates.ts';
import {emptyState, type AppState} from '../../shared/types.ts';

/** True in the standalone demo build (`npm run build:demo`): no server, sample data. */
export const IS_DEMO = import.meta.env.VITE_DEMO === '1';

/** Sample data for the demo build: a month of a challenge plus today's plan. */
export function demoState(now = new Date()): AppState {
  const today = toISODate(now);
  const start = addDays(today, -28);
  const created = now.getTime() - 28 * 86_400_000;
  let s = emptyState();
  const girl = CHALLENGES.find(c => c.id === 'that-girl')!;
  const habits = [
    ...girl.habits.slice(0, 4).map((h, i) => ({...h, id: `demo-h${i}`, challenge: girl.id})),
    {id: 'demo-water', name: '2 л воды', emoji: '💧'},
  ];
  habits.forEach(h =>
    (s = upsertHabit(s, {
      ...h,
      days: EVERY_DAY,
      startDate: start,
      createdAt: created,
      updatedAt: created,
    })),
  );
  // A believable history: most days done, a few misses.
  habits.forEach((h, i) => {
    for (let d = 1; d <= 28; d++) {
      if ((d * (i + 3)) % 7 !== 0) s = setCheck(s, h.id, addDays(today, -d), true, created);
    }
  });
  s = setCheck(s, 'demo-h0', today, true, created);
  const tasks: [string, string | undefined, number | undefined, boolean][] = [
    ['Созвон с командой', '11:00', 30, true],
    ['Дописать отчёт', '12:00', 90, false],
    ['Зал: ноги', '18:30', 60, false],
    ['Купить продукты', undefined, undefined, false],
  ];
  tasks.forEach(([title, time, durationMin, done], i) =>
    (s = upsertTask(s, {
      id: `demo-t${i}`,
      title,
      date: today,
      done,
      ...(time ? {time} : {}),
      ...(durationMin ? {durationMin} : {}),
      updatedAt: created,
    })),
  );
  return s;
}
