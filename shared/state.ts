import {addDays, isISODate, isISOTime, toISODate, weekdayOf} from './dates.ts';
import type {
  AppState,
  BaseRecord,
  Habit,
  HabitCheck,
  ISODate,
  Task,
  Weekday,
} from './types.ts';

export const newId = () => crypto.randomUUID();
export const checkId = (habitId: string, date: ISODate) => `${habitId}:${date}`;

// ---------------------------------------------------------------- merge

function mergeTable<T extends BaseRecord>(
  a: Record<string, T>,
  b: Record<string, T>,
): Record<string, T> {
  const out: Record<string, T> = {...a};
  for (const [id, rec] of Object.entries(b)) {
    const cur = out[id];
    if (!cur || rec.updatedAt > cur.updatedAt) out[id] = rec;
  }
  return out;
}

/** Last-write-wins per record. Commutative, so either side may call it. */
export function mergeStates(a: AppState, b: AppState): AppState {
  return {
    habits: mergeTable(a.habits, b.habits),
    tasks: mergeTable(a.tasks, b.tasks),
    checks: mergeTable(a.checks, b.checks),
  };
}

// ----------------------------------------------------------- validation

const MAX_TEXT = 500;
const isStr = (v: unknown, max = MAX_TEXT): v is string =>
  typeof v === 'string' && v.length <= max;
const isNum = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);
const isDuration = (v: unknown) =>
  v === undefined || (isNum(v) && v > 0 && v <= 24 * 60);
const isBase = (v: Record<string, unknown>, id: string) =>
  v.id === id && isNum(v.updatedAt) && (v.deleted === undefined || typeof v.deleted === 'boolean');
const isWeekdays = (v: unknown): v is Weekday[] =>
  Array.isArray(v) && v.every(d => Number.isInteger(d) && d >= 0 && d <= 6);

function isHabit(v: Record<string, unknown>, id: string): boolean {
  return (
    isBase(v, id) &&
    isStr(v.name) &&
    isStr(v.emoji, 16) &&
    isWeekdays(v.days) &&
    (v.time === undefined || isISOTime(v.time)) &&
    isDuration(v.durationMin) &&
    (v.challenge === undefined || isStr(v.challenge, 64)) &&
    isNum(v.createdAt)
  );
}

function isTask(v: Record<string, unknown>, id: string): boolean {
  return (
    isBase(v, id) &&
    isStr(v.title) &&
    isISODate(v.date) &&
    (v.time === undefined || isISOTime(v.time)) &&
    isDuration(v.durationMin) &&
    typeof v.done === 'boolean' &&
    (v.notes === undefined || isStr(v.notes, 4000))
  );
}

function isCheck(v: Record<string, unknown>, id: string): boolean {
  return (
    isBase(v, id) &&
    isStr(v.habitId, 64) &&
    isISODate(v.date) &&
    id === checkId(v.habitId, v.date) &&
    typeof v.done === 'boolean'
  );
}

function pickValid<T>(
  table: unknown,
  ok: (v: Record<string, unknown>, id: string) => boolean,
): Record<string, T> {
  const out: Record<string, T> = {};
  if (!table || typeof table !== 'object') return out;
  for (const [id, v] of Object.entries(table)) {
    if (id.length <= 140 && v && typeof v === 'object' && ok(v as Record<string, unknown>, id)) {
      out[id] = v as T;
    }
  }
  return out;
}

/** Keeps only well-formed records; anything malformed is dropped, not repaired. */
export function sanitizeState(raw: unknown): AppState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    habits: pickValid<Habit>(r.habits, isHabit),
    tasks: pickValid<Task>(r.tasks, isTask),
    checks: pickValid<HabitCheck>(r.checks, isCheck),
  };
}

// -------------------------------------------------------------- queries

export const liveHabits = (s: AppState) =>
  Object.values(s.habits)
    .filter(h => !h.deleted)
    .sort((a, b) => (a.time ?? '99').localeCompare(b.time ?? '99') || a.createdAt - b.createdAt);

export const tasksOn = (s: AppState, date: ISODate) =>
  Object.values(s.tasks)
    .filter(t => !t.deleted && t.date === date)
    .sort((a, b) => (a.time ?? '99').localeCompare(b.time ?? '99') || a.title.localeCompare(b.title));

export const isDueOn = (h: Habit, date: ISODate) =>
  h.days.includes(weekdayOf(date));

export const habitsDueOn = (s: AppState, date: ISODate) =>
  liveHabits(s).filter(h => isDueOn(h, date));

export function isChecked(s: AppState, habitId: string, date: ISODate): boolean {
  const c = s.checks[checkId(habitId, date)];
  return !!c && !c.deleted && c.done;
}

/**
 * Consecutive due days completed, counting back from `today`.
 * Today only breaks the streak once it is over, so an unchecked today
 * still shows yesterday's streak.
 */
export function currentStreak(s: AppState, h: Habit, today: ISODate): number {
  let streak = 0;
  let date = today;
  const floor = addDays(toISODate(new Date(h.createdAt)), -1);
  for (let i = 0; i < 3660 && date > floor; i++, date = addDays(date, -1)) {
    if (!isDueOn(h, date)) continue;
    if (isChecked(s, h.id, date)) streak++;
    else if (date !== today) break;
  }
  return streak;
}

export interface DayProgress {
  done: number;
  total: number;
}

export function dayProgress(s: AppState, date: ISODate): DayProgress {
  const habits = habitsDueOn(s, date);
  const tasks = tasksOn(s, date);
  return {
    total: habits.length + tasks.length,
    done:
      habits.filter(h => isChecked(s, h.id, date)).length +
      tasks.filter(t => t.done).length,
  };
}

/** Share of due days completed in [from, to]; null when nothing was due. */
export function completionRate(
  s: AppState,
  h: Habit,
  from: ISODate,
  to: ISODate,
): number | null {
  let due = 0;
  let done = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (!isDueOn(h, d)) continue;
    due++;
    if (isChecked(s, h.id, d)) done++;
  }
  return due === 0 ? null : done / due;
}

// ------------------------------------------------------------ mutations
// Each returns a new state; `now` is injectable for tests.

export function setCheck(
  s: AppState,
  habitId: string,
  date: ISODate,
  done: boolean,
  now = Date.now(),
): AppState {
  const id = checkId(habitId, date);
  return {...s, checks: {...s.checks, [id]: {id, habitId, date, done, updatedAt: now}}};
}

export function upsertTask(s: AppState, task: Task): AppState {
  return {...s, tasks: {...s.tasks, [task.id]: task}};
}

export function upsertHabit(s: AppState, habit: Habit): AppState {
  return {...s, habits: {...s.habits, [habit.id]: habit}};
}

export function deleteTask(s: AppState, id: string, now = Date.now()): AppState {
  const t = s.tasks[id];
  return t ? upsertTask(s, {...t, deleted: true, updatedAt: now}) : s;
}

export function deleteHabit(s: AppState, id: string, now = Date.now()): AppState {
  const h = s.habits[id];
  return h ? upsertHabit(s, {...h, deleted: true, updatedAt: now}) : s;
}
