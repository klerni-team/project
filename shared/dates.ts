import type {ISODate, ISOTime, Weekday} from './types.ts';

const pad = (n: number) => String(n).padStart(2, '0');

export function toISODate(d: Date): ISODate {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function toISOTime(d: Date): ISOTime {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Parses `YYYY-MM-DD` as a local-time date at noon (noon avoids DST edges). */
export function parseISODate(date: ISODate): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

export function addDays(date: ISODate, days: number): ISODate {
  const d = parseISODate(date);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

export function weekdayOf(date: ISODate): Weekday {
  return parseISODate(date).getDay() as Weekday;
}

export const isISODate = (v: unknown): v is ISODate =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  toISODate(parseISODate(v)) === v;

export const isISOTime = (v: unknown): v is ISOTime =>
  typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

/** Monday of the week containing `date`. */
export function startOfWeek(date: ISODate): ISODate {
  const wd = weekdayOf(date);
  return addDays(date, wd === 0 ? -6 : 1 - wd);
}

const WEEKDAY_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
export const weekdayShort = (wd: Weekday) => WEEKDAY_SHORT[wd];

export function formatDayTitle(date: ISODate, today: ISODate): string {
  if (date === today) return 'Сегодня';
  if (date === addDays(today, 1)) return 'Завтра';
  if (date === addDays(today, -1)) return 'Вчера';
  return parseISODate(date).toLocaleDateString('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}
