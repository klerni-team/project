import type {Org} from './api.ts';
import type {Niche} from './niches.ts';

export interface Found extends Org {
  /** Queries of the niche that returned this organization. */
  queries: string[];
}

export const COLUMNS = [
  'Название', 'Телефоны', 'Сайт', 'Адрес', 'Категории', 'Часы работы',
  'Широта', 'Долгота', 'ID Яндекса', 'Карточка', 'Найдено по запросу',
];

export const cardUrl = (id: string) => id ? `https://yandex.ru/maps/org/${encodeURIComponent(id)}` : '';

export function orgRow(o: Found): string[] {
  return [
    o.name, o.phones.join(', '), o.url, o.address, o.categories.join(', '), o.hours,
    o.lat === null ? '' : String(o.lat), o.lon === null ? '' : String(o.lon),
    o.id, cardUrl(o.id), o.queries.join(', '),
  ];
}

export function csvCell(value: string): string {
  let v = value;
  // Spreadsheets run cells starting with = + - @ as formulas; phone numbers like +7 (843) … stay as they are.
  if (/^[=@\t\r]/.test(v) || (/^[+-]/.test(v) && /[^\d\s()+\-.,]/.test(v))) v = `'${v}`;
  return /[;"\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

/** UTF-8 with BOM and `;` separators, so Excel opens it with Cyrillic intact. */
export function toCsv(rows: string[][]): string {
  return '﻿' + [COLUMNS, ...rows].map(r => r.map(csvCell).join(';') + '\r\n').join('');
}

/** A name that is valid on Windows, macOS and Linux. */
export function safeFileName(s: string): string {
  const name = s
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150)
    .replace(/[. ]+$/, '');
  if (!name) return '_';
  return /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name) ? `_${name}` : name;
}

export const nicheFileName = (n: Niche) => `${n.code} ${safeFileName(n.title)}.csv`;
