import {addDays, isISODate, isISOTime, weekdayOf} from './dates.ts';
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

export const TABLES = ['habits', 'tasks', 'checks'] as const;
export type TableName = (typeof TABLES)[number];

/** Text limits shared by forms, agent tools and server validation. */
export const LIMITS = {title: 300, notes: 2000, emoji: 16} as const;

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

/** Records in `s` stamped at or after `since` (local edits not yet pushed). */
export function changedSince(s: AppState, since: number): AppState {
  const pick = <T extends BaseRecord>(t: Record<string, T>) =>
    Object.fromEntries(Object.entries(t).filter(([, r]) => r.updatedAt >= since));
  return {habits: pick(s.habits), tasks: pick(s.tasks), checks: pick(s.checks)};
}

/**
 * A device with a clock far in the future would win every merge forever.
 * The server pulls such timestamps back to its own time.
 */
export function clampFuture(s: AppState, now: number, skewMs = 5 * 60_000): AppState {
  const fix = <T extends BaseRecord>(t: Record<string, T>) =>
    Object.fromEntries(
      Object.entries(t).map(([id, r]) => [id, r.updatedAt > now + skewMs ? {...r, updatedAt: now} : r]),
    );
  return {habits: fix(s.habits), tasks: fix(s.tasks), checks: fix(s.checks)};
}

/**
 * Re-applies the field edits that turned `before` into `after` on top of
 * `current`. Used when the agent worked on a snapshot: fields the user
 * changed meanwhile on the same record survive unless the agent changed
 * that same field.
 */
export function rebaseChanges(current: AppState, before: AppState, after: AppState, now: number): AppState {
  const out: AppState = {habits: {...current.habits}, tasks: {...current.tasks}, checks: {...current.checks}};
  for (const table of TABLES) {
    const prev = before[table] as Record<string, BaseRecord>;
    const next = after[table] as Record<string, BaseRecord>;
    const target = out[table] as Record<string, BaseRecord>;
    for (const [id, rec] of Object.entries(next)) {
      const old = prev[id];
      if (old === rec) continue;
      const base = target[id] ?? old;
      if (!base) {
        target[id] = rec;
        continue;
      }
      const merged: Record<string, unknown> = {...base};
      const keys = new Set([...Object.keys(old ?? {}), ...Object.keys(rec)]);
      for (const k of keys) {
        const a = (old as unknown as Record<string, unknown> | undefined)?.[k];
        const b = (rec as unknown as Record<string, unknown>)[k];
        if (k === 'updatedAt' || JSON.stringify(a) === JSON.stringify(b)) continue;
        if (b === undefined) delete merged[k];
        else merged[k] = b;
      }
      merged.updatedAt = Math.max(now, base.updatedAt + 1);
      target[id] = merged as unknown as BaseRecord;
    }
  }
  return out;
}

// ----------------------------------------------------------- validation

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isDuration = (v: unknown) => v === undefined || (isNum(v) && v > 0 && v <= 24 * 60);
const isWeekdays = (v: unknown): v is Weekday[] =>
  Array.isArray(v) && v.length > 0 && v.every(d => Number.isInteger(d) && d >= 0 && d <= 6);

/** Non-empty string, clipped to `max` (over-long text is truncated, never dropped). */
function text(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.slice(0, max) : null;
}

type Raw = Record<string, unknown>;

function base(v: Raw, id: string): BaseRecord | null {
  if (v.id !== id || !isNum(v.updatedAt)) return null;
  if (v.deleted !== undefined && typeof v.deleted !== 'boolean') return null;
  return {id, updatedAt: v.updatedAt, ...(v.deleted ? {deleted: true} : {})};
}

function optionalTiming(v: Raw): {time?: string; durationMin?: number} | null {
  if (v.time !== undefined && !isISOTime(v.time)) return null;
  if (!isDuration(v.durationMin)) return null;
  return {
    ...(v.time !== undefined ? {time: v.time as string} : {}),
    ...(v.durationMin !== undefined ? {durationMin: v.durationMin as number} : {}),
  };
}

function toHabit(v: Raw, id: string): Habit | null {
  const b = base(v, id);
  const name = text(v.name, LIMITS.title);
  const timing = optionalTiming(v);
  if (!b || !name || !timing || !isWeekdays(v.days) || !isISODate(v.startDate) || !isNum(v.createdAt)) return null;
  const challenge = text(v.challenge, 64);
  return {
    ...b,
    name,
    emoji: text(v.emoji, LIMITS.emoji) ?? '✅',
    days: v.days,
    startDate: v.startDate,
    createdAt: v.createdAt,
    ...timing,
    ...(challenge ? {challenge} : {}),
  };
}

function toTask(v: Raw, id: string): Task | null {
  const b = base(v, id);
  const title = text(v.title, LIMITS.title);
  const timing = optionalTiming(v);
  if (!b || !title || !timing || !isISODate(v.date) || typeof v.done !== 'boolean') return null;
  const notes = text(v.notes, LIMITS.notes);
  return {...b, title, date: v.date, done: v.done, ...timing, ...(notes ? {notes} : {})};
}

function toCheck(v: Raw, id: string): HabitCheck | null {
  const b = base(v, id);
  if (!b || typeof v.habitId !== 'string' || !isISODate(v.date) || typeof v.done !== 'boolean') return null;
  if (id !== checkId(v.habitId, v.date)) return null;
  return {...b, habitId: v.habitId, date: v.date, done: v.done};
}

function pick<T>(table: unknown, parse: (v: Raw, id: string) => T | null): Record<string, T> {
  const out: Record<string, T> = {};
  if (!table || typeof table !== 'object') return out;
  for (const [id, v] of Object.entries(table)) {
    if (id.length > 140 || !v || typeof v !== 'object') continue;
    const rec = parse(v as Raw, id);
    if (rec) out[id] = rec;
  }
  return out;
}

/**
 * Rebuilds a state from untrusted JSON: known fields only, long text
 * clipped, structurally broken records dropped.
 */
export function sanitizeState(raw: unknown): AppState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Raw;
  return {
    habits: pick(r.habits, toHabit),
    tasks: pick(r.tasks, toTask),
    checks: pick(r.checks, toCheck),
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

/** Due on a weekday it is scheduled for, from its start date on. */
export const isDueOn = (h: Habit, date: ISODate) =>
  date >= h.startDate && h.days.includes(weekdayOf(date));

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
  for (let i = 0; i < 3660 && date >= h.startDate; i++, date = addDays(date, -1)) {
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
