import {describe, expect, it} from 'vitest';
import {addDays, isISODate, startOfWeek, weekdayOf} from './dates.ts';
import {
  changedSince,
  checkId,
  clampFuture,
  completionRate,
  rebaseChanges,
  currentStreak,
  dayProgress,
  mergeStates,
  sanitizeState,
  setCheck,
  upsertHabit,
  upsertTask,
} from './state.ts';
import {emptyState, type Habit, type Task} from './types.ts';

const habit = (over: Partial<Habit> = {}): Habit => ({
  id: 'h1',
  name: 'Вода',
  emoji: '💧',
  days: [0, 1, 2, 3, 4, 5, 6],
  startDate: '2026-01-01',
  createdAt: new Date(2026, 0, 1, 9).getTime(),
  updatedAt: 1,
  ...over,
});

const task = (over: Partial<Task> = {}): Task => ({
  id: 't1',
  title: 'Отчёт',
  date: '2026-10-08',
  done: false,
  updatedAt: 1,
  ...over,
});

describe('dates', () => {
  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('rejects impossible dates', () => {
    expect(isISODate('2026-02-30')).toBe(false);
    expect(isISODate('2026-10-08')).toBe(true);
  });
  it('computes weekday and Monday start', () => {
    expect(weekdayOf('2026-10-08')).toBe(4); // Thursday
    expect(startOfWeek('2026-10-08')).toBe('2026-10-05');
    expect(startOfWeek('2026-10-11')).toBe('2026-10-05'); // Sunday belongs to the week before
  });
});

describe('mergeStates', () => {
  it('keeps the newer record from either side', () => {
    const a = upsertTask(emptyState(), task({title: 'old', updatedAt: 1}));
    const b = upsertTask(emptyState(), task({title: 'new', updatedAt: 2}));
    expect(mergeStates(a, b).tasks.t1.title).toBe('new');
    expect(mergeStates(b, a).tasks.t1.title).toBe('new');
  });
  it('propagates tombstones', () => {
    const a = upsertTask(emptyState(), task({updatedAt: 1}));
    const b = upsertTask(emptyState(), task({deleted: true, updatedAt: 5}));
    expect(mergeStates(a, b).tasks.t1.deleted).toBe(true);
  });
  it('unions records that exist on one side only', () => {
    const a = upsertTask(emptyState(), task({id: 'a'}));
    const b = upsertHabit(emptyState(), habit());
    const m = mergeStates(a, b);
    expect(Object.keys(m.tasks)).toEqual(['a']);
    expect(Object.keys(m.habits)).toEqual(['h1']);
  });
});

describe('sanitizeState', () => {
  it('drops malformed records and keeps valid ones', () => {
    const s = sanitizeState({
      tasks: {
        t1: task(),
        bad: {id: 'bad', title: 1, date: 'x', done: false, updatedAt: 1},
        mismatch: task({id: 'other'}),
      },
      habits: {h1: habit(), h2: {...habit({id: 'h2'}), days: [9]}},
      checks: {[checkId('h1', '2026-10-08')]: {id: 'h1:2026-10-08', habitId: 'h1', date: '2026-10-08', done: true, updatedAt: 1}},
    });
    expect(Object.keys(s.tasks)).toEqual(['t1']);
    expect(Object.keys(s.habits)).toEqual(['h1']);
    expect(Object.keys(s.checks)).toEqual(['h1:2026-10-08']);
  });
  it('clips over-long text instead of dropping the record', () => {
    const s = sanitizeState({tasks: {t1: task({title: 'x'.repeat(5000), notes: 'n'.repeat(9000)})}});
    expect(s.tasks.t1.title).toHaveLength(300);
    expect(s.tasks.t1.notes).toHaveLength(2000);
  });
  it('drops unknown fields', () => {
    const s = sanitizeState({tasks: {t1: {...task(), evil: '<script>'}}});
    expect(Object.keys(s.tasks.t1)).not.toContain('evil');
  });
  it('survives garbage input', () => {
    expect(sanitizeState(null)).toEqual(emptyState());
    expect(sanitizeState({tasks: 'nope'})).toEqual(emptyState());
  });
});

describe('streaks and progress', () => {
  const today = '2026-10-08';
  const base = upsertHabit(emptyState(), habit());

  it('counts consecutive checked days and ignores an unchecked today', () => {
    let s = base;
    for (const d of [addDays(today, -1), addDays(today, -2), addDays(today, -3)]) s = setCheck(s, 'h1', d, true);
    expect(currentStreak(s, s.habits.h1, today)).toBe(3);
    s = setCheck(s, 'h1', today, true);
    expect(currentStreak(s, s.habits.h1, today)).toBe(4);
  });

  it('breaks on a missed past day', () => {
    let s = setCheck(base, 'h1', addDays(today, -1), true);
    s = setCheck(s, 'h1', addDays(today, -3), true);
    expect(currentStreak(s, s.habits.h1, today)).toBe(1);
  });

  it('skips days the habit is not due', () => {
    // Due Mon/Wed/Fri only; today is Thursday.
    let s = upsertHabit(emptyState(), habit({days: [1, 3, 5]}));
    s = setCheck(s, 'h1', '2026-10-07', true); // Wed
    s = setCheck(s, 'h1', '2026-10-05', true); // Mon
    expect(currentStreak(s, s.habits.h1, today)).toBe(2);
  });

  it('treats an unchecked check record as not done', () => {
    let s = setCheck(base, 'h1', addDays(today, -1), true);
    s = setCheck(s, 'h1', addDays(today, -1), false);
    expect(currentStreak(s, s.habits.h1, today)).toBe(0);
  });

  it('computes day progress over habits and tasks', () => {
    let s = upsertTask(base, task({date: today, done: true}));
    s = upsertTask(s, task({id: 't2', date: today}));
    s = upsertTask(s, task({id: 't3', date: today, deleted: true}));
    s = setCheck(s, 'h1', today, true);
    expect(dayProgress(s, today)).toEqual({done: 2, total: 3});
  });

  it('completion rate is null when nothing was due', () => {
    const s = upsertHabit(emptyState(), habit({days: [1]}));
    expect(completionRate(s, s.habits.h1, '2026-10-06', '2026-10-08')).toBeNull();
    expect(completionRate(s, s.habits.h1, '2026-10-05', '2026-10-08')).toBe(0);
  });
});

describe('sync helpers', () => {
  it('changedSince picks records stamped at or after the watermark', () => {
    let s = upsertTask(emptyState(), task({id: 'old', updatedAt: 10}));
    s = upsertTask(s, task({id: 'new', updatedAt: 20}));
    expect(Object.keys(changedSince(s, 20).tasks)).toEqual(['new']);
  });

  it('clampFuture pulls far-future timestamps back to now', () => {
    const s = upsertTask(emptyState(), task({updatedAt: 1e308}));
    expect(clampFuture(s, 1000).tasks.t1.updatedAt).toBe(1000);
    const near = upsertTask(emptyState(), task({updatedAt: 1000 + 60_000}));
    expect(clampFuture(near, 1000).tasks.t1.updatedAt).toBe(61_000);
  });

  it('rebaseChanges keeps a concurrent user edit on another field', () => {
    const before = upsertTask(emptyState(), task({time: '10:00', updatedAt: 1}));
    // Agent moved the task to tomorrow and dropped its time.
    const {time: _t, ...moved} = before.tasks.t1;
    const after = upsertTask(before, {...moved, date: '2026-10-09', updatedAt: 5});
    // Meanwhile the user ticked it done.
    const current = upsertTask(before, {...before.tasks.t1, done: true, updatedAt: 3});
    const out = rebaseChanges(current, before, after, 10).tasks.t1;
    expect(out).toMatchObject({date: '2026-10-09', done: true, updatedAt: 10});
    expect(out.time).toBeUndefined();
  });

  it('rebaseChanges adds new records and leaves untouched ones alone', () => {
    const before = upsertTask(emptyState(), task());
    const after = upsertTask(before, task({id: 't2', title: 'Новая'}));
    const current = upsertTask(before, task({id: 't3'}));
    const out = rebaseChanges(current, before, after, 10);
    expect(Object.keys(out.tasks).sort()).toEqual(['t1', 't2', 't3']);
    expect(out.tasks.t1).toBe(current.tasks.t1);
  });
});

describe('habit start date', () => {
  it('days before the start never count as due or missed', () => {
    let s = upsertHabit(emptyState(), habit({startDate: '2026-10-08'}));
    s = setCheck(s, 'h1', '2026-10-08', true);
    expect(completionRate(s, s.habits.h1, '2026-09-25', '2026-10-08')).toBe(1);
    expect(dayProgress(s, '2026-10-07')).toEqual({done: 0, total: 0});
    expect(currentStreak(s, s.habits.h1, '2026-10-08')).toBe(1);
  });
});
