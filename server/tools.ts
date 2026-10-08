import type Anthropic from '@anthropic-ai/sdk';
import {addDays, isISODate, isISOTime} from '../shared/dates.ts';
import {
  completionRate,
  currentStreak,
  deleteHabit,
  deleteTask,
  habitsDueOn,
  isChecked,
  liveHabits,
  newId,
  LIMITS,
  setCheck,
  tasksOn,
  upsertHabit,
  upsertTask,
} from '../shared/state.ts';
import type {AppState, Habit, ISODate, Task, Weekday} from '../shared/types.ts';
import {EVERY_DAY} from '../shared/templates.ts';

// Planner tools the agent can call. They run against an in-memory copy of
// the user's state; the caller persists the result once the turn finishes.

export class ToolInputError extends Error {}

export interface ToolContext {
  state: AppState;
  today: ISODate;
  now: () => number;
}

export interface ToolOutcome {
  /** JSON-serialisable result returned to the model. */
  result: unknown;
  /** One line shown to the user under the reply. */
  summary: string;
}

type Input = Record<string, unknown>;

const DATE = {type: 'string', description: 'Date as YYYY-MM-DD.'} as const;
const TIME = {type: 'string', description: 'Local start time as HH:MM (24h).'} as const;
const DURATION = {type: 'integer', minimum: 5, maximum: 720, description: 'Length in minutes.'} as const;
const DAYS = {
  type: 'array',
  items: {type: 'integer', minimum: 0, maximum: 6},
  description: 'Weekdays the habit is due, 0 = Sunday … 6 = Saturday. Omit for every day.',
} as const;

export const TOOL_DEFS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'get_day',
    description:
      "Returns one day's plan: tasks (with id, time, duration, done) and the habits due that day with whether each is checked. Call this before planning or rescheduling a day.",
    input_schema: {type: 'object', properties: {date: DATE}, required: ['date'], additionalProperties: false},
  },
  {
    name: 'list_habits',
    description:
      'Lists all habits with id, schedule, time slot, current streak and completion rate over the last 14 days.',
    input_schema: {type: 'object', properties: {}, additionalProperties: false},
  },
  {
    name: 'add_task',
    description:
      'Adds a task to a day. Give a time and duration when the user wants it scheduled on the timeline; omit both for an unscheduled to-do.',
    input_schema: {
      type: 'object',
      properties: {
        title: {type: 'string', description: 'Short task title in the user language.'},
        date: DATE,
        time: TIME,
        duration_min: DURATION,
        notes: {type: 'string'},
      },
      required: ['title', 'date'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_task',
    description:
      'Changes an existing task: reschedule (date/time), rename, set duration, mark done or not done. Pass time as an empty string to make it unscheduled.',
    input_schema: {
      type: 'object',
      properties: {
        id: {type: 'string'},
        title: {type: 'string'},
        date: DATE,
        time: {type: 'string', description: 'HH:MM, or "" to remove the time.'},
        duration_min: DURATION,
        done: {type: 'boolean'},
        notes: {type: 'string'},
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_task',
    description: 'Deletes a task. Only when the user asks to remove it.',
    input_schema: {type: 'object', properties: {id: {type: 'string'}}, required: ['id'], additionalProperties: false},
  },
  {
    name: 'add_habit',
    description: 'Creates a recurring habit.',
    input_schema: {
      type: 'object',
      properties: {
        name: {type: 'string'},
        emoji: {type: 'string', description: 'One emoji.'},
        days: DAYS,
        time: TIME,
        duration_min: DURATION,
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_habit',
    description: 'Changes a habit: name, emoji, weekdays, time slot ("" removes it) or duration.',
    input_schema: {
      type: 'object',
      properties: {
        id: {type: 'string'},
        name: {type: 'string'},
        emoji: {type: 'string'},
        days: DAYS,
        time: {type: 'string', description: 'HH:MM, or "" to remove the time.'},
        duration_min: DURATION,
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_habit',
    description: 'Deletes a habit. Only when the user explicitly asks to remove it.',
    input_schema: {type: 'object', properties: {id: {type: 'string'}}, required: ['id'], additionalProperties: false},
  },
  {
    name: 'set_habit_done',
    description: 'Marks a habit as done or not done on a date.',
    input_schema: {
      type: 'object',
      properties: {habit_id: {type: 'string'}, date: DATE, done: {type: 'boolean'}},
      required: ['habit_id', 'date', 'done'],
      additionalProperties: false,
    },
  },
];

// ------------------------------------------------------------ validators

function str(input: Input, key: string, max: number = LIMITS.title): string | undefined {
  const v = input[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.trim() === '' || v.length > max) {
    throw new ToolInputError(`${key} must be a non-empty string up to ${max} chars`);
  }
  return v.trim();
}

function reqStr(input: Input, key: string, max?: number): string {
  const v = str(input, key, max);
  if (v === undefined) throw new ToolInputError(`${key} is required`);
  return v;
}

function date(input: Input, key: string): ISODate | undefined {
  const v = input[key];
  if (v === undefined) return undefined;
  if (!isISODate(v)) throw new ToolInputError(`${key} must be a real date as YYYY-MM-DD`);
  return v;
}

/** undefined = not given, null = clear it. */
function time(input: Input, key: string): string | null | undefined {
  const v = input[key];
  if (v === undefined) return undefined;
  if (v === '') return null;
  if (!isISOTime(v)) throw new ToolInputError(`${key} must be HH:MM (24h)`);
  return v;
}

function duration(input: Input): number | undefined {
  const v = input.duration_min;
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || (v as number) < 5 || (v as number) > 720) {
    throw new ToolInputError('duration_min must be an integer between 5 and 720');
  }
  return v as number;
}

function bool(input: Input, key: string): boolean | undefined {
  const v = input[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new ToolInputError(`${key} must be true or false`);
  return v;
}

function days(input: Input): Weekday[] | undefined {
  const v = input.days;
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length === 0 || !v.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) {
    throw new ToolInputError('days must be a non-empty array of integers 0..6');
  }
  return [...new Set(v as Weekday[])].sort();
}

function findTask(ctx: ToolContext, id: string): Task {
  const t = ctx.state.tasks[id];
  if (!t || t.deleted) throw new ToolInputError(`no task with id ${id}; call get_day to see ids`);
  return t;
}

function findHabit(ctx: ToolContext, id: string): Habit {
  const h = ctx.state.habits[id];
  if (!h || h.deleted) throw new ToolInputError(`no habit with id ${id}; call list_habits to see ids`);
  return h;
}

/** Applies a `time` input: null clears the field, undefined keeps it. */
function withTime<T extends {time?: string}>(rec: T, t: string | null | undefined): T {
  if (t === undefined) return rec;
  const {time: _old, ...rest} = rec;
  return (t === null ? rest : {...rest, time: t}) as T;
}

const taskView = (t: Task) => ({
  id: t.id,
  title: t.title,
  time: t.time ?? null,
  duration_min: t.durationMin ?? null,
  done: t.done,
  notes: t.notes ?? null,
});

const when = (d: ISODate, t?: string) => (t ? `${d} ${t}` : d);

// -------------------------------------------------------------- handlers

const handlers: Record<string, (ctx: ToolContext, input: Input) => ToolOutcome> = {
  get_day(ctx, input) {
    const d = date(input, 'date') ?? ctx.today;
    return {
      summary: `Посмотрел ${d}`,
      result: {
        date: d,
        tasks: tasksOn(ctx.state, d).map(taskView),
        habits: habitsDueOn(ctx.state, d).map(h => ({
          id: h.id,
          name: h.name,
          time: h.time ?? null,
          duration_min: h.durationMin ?? null,
          done: isChecked(ctx.state, h.id, d),
        })),
      },
    };
  },

  list_habits(ctx) {
    const from = addDays(ctx.today, -13);
    return {
      summary: 'Посмотрел привычки',
      result: liveHabits(ctx.state).map(h => ({
        id: h.id,
        name: h.name,
        emoji: h.emoji,
        days: h.days,
        time: h.time ?? null,
        duration_min: h.durationMin ?? null,
        streak: currentStreak(ctx.state, h, ctx.today),
        rate_14d: completionRate(ctx.state, h, from, ctx.today),
      })),
    };
  },

  add_task(ctx, input) {
    const t: Task = {
      id: newId(),
      title: reqStr(input, 'title'),
      date: date(input, 'date') ?? ctx.today,
      done: false,
      updatedAt: ctx.now(),
    };
    const tm = time(input, 'time');
    if (tm) t.time = tm;
    const dur = duration(input);
    if (dur) t.durationMin = dur;
    const notes = str(input, 'notes', LIMITS.notes);
    if (notes) t.notes = notes;
    ctx.state = upsertTask(ctx.state, t);
    return {summary: `Добавил «${t.title}» · ${when(t.date, t.time)}`, result: taskView(t)};
  },

  update_task(ctx, input) {
    const prev = findTask(ctx, reqStr(input, 'id', 64));
    let t: Task = {...prev, updatedAt: ctx.now()};
    const title = str(input, 'title');
    if (title) t.title = title;
    const d = date(input, 'date');
    if (d) t.date = d;
    t = withTime(t, time(input, 'time'));
    const dur = duration(input);
    if (dur) t.durationMin = dur;
    const done = bool(input, 'done');
    if (done !== undefined) t.done = done;
    const notes = str(input, 'notes', LIMITS.notes);
    if (notes) t.notes = notes;
    ctx.state = upsertTask(ctx.state, t);
    const moved = t.date !== prev.date || t.time !== prev.time;
    const summary = moved
      ? `Перенёс «${t.title}» на ${when(t.date, t.time)}`
      : done === true
        ? `Отметил «${t.title}» выполненной`
        : `Изменил «${t.title}»`;
    return {summary, result: taskView(t)};
  },

  delete_task(ctx, input) {
    const t = findTask(ctx, reqStr(input, 'id', 64));
    ctx.state = deleteTask(ctx.state, t.id, ctx.now());
    return {summary: `Удалил «${t.title}»`, result: {deleted: t.id}};
  },

  add_habit(ctx, input) {
    const now = ctx.now();
    const h: Habit = {
      id: newId(),
      name: reqStr(input, 'name'),
      emoji: str(input, 'emoji', LIMITS.emoji) ?? '✅',
      days: days(input) ?? EVERY_DAY,
      startDate: ctx.today,
      createdAt: now,
      updatedAt: now,
    };
    const tm = time(input, 'time');
    if (tm) h.time = tm;
    const dur = duration(input);
    if (dur) h.durationMin = dur;
    ctx.state = upsertHabit(ctx.state, h);
    return {summary: `Новая привычка ${h.emoji} ${h.name}`, result: {id: h.id}};
  },

  update_habit(ctx, input) {
    const prev = findHabit(ctx, reqStr(input, 'id', 64));
    let h: Habit = {...prev, updatedAt: ctx.now()};
    const name = str(input, 'name');
    if (name) h.name = name;
    const emoji = str(input, 'emoji', LIMITS.emoji);
    if (emoji) h.emoji = emoji;
    const ds = days(input);
    if (ds) h.days = ds;
    h = withTime(h, time(input, 'time'));
    const dur = duration(input);
    if (dur) h.durationMin = dur;
    ctx.state = upsertHabit(ctx.state, h);
    return {summary: `Изменил привычку ${h.emoji} ${h.name}`, result: {id: h.id}};
  },

  delete_habit(ctx, input) {
    const h = findHabit(ctx, reqStr(input, 'id', 64));
    ctx.state = deleteHabit(ctx.state, h.id, ctx.now());
    return {summary: `Удалил привычку ${h.name}`, result: {deleted: h.id}};
  },

  set_habit_done(ctx, input) {
    const h = findHabit(ctx, reqStr(input, 'habit_id', 64));
    const d = date(input, 'date') ?? ctx.today;
    const done = bool(input, 'done');
    if (done === undefined) throw new ToolInputError('done is required');
    ctx.state = setCheck(ctx.state, h.id, d, done, ctx.now());
    return {summary: `${done ? 'Отметил' : 'Снял отметку'}: ${h.emoji} ${h.name} · ${d}`, result: {ok: true}};
  },
};

/** Throws ToolInputError for bad input or an unknown tool. */
export function runTool(ctx: ToolContext, name: string, input: unknown): ToolOutcome {
  const handler = Object.hasOwn(handlers, name) ? handlers[name] : undefined;
  if (!handler) throw new ToolInputError(`unknown tool ${name}`);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ToolInputError('input must be an object');
  }
  return handler(ctx, input as Input);
}
