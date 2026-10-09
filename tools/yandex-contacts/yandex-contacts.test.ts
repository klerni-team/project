import {mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {parseBBox, parseResponse, YandexApi, type BBox, type Org} from './api.ts';
import {NicheResults, searchArea, splitBBox} from './collect.ts';
import {csvCell, nicheFileName, safeFileName, toCsv} from './csv.ts';
import {main} from './main.ts';
import {NICHES, selectNiches} from './niches.ts';

const KEY = 'secret-key-0123456789';
const CITY: BBox = [[49, 55.7], [49.4, 55.9]];

interface FakeOrg {
  id: string;
  lon: number;
  lat: number;
  /** Queries that find it. */
  tags: string[];
  name?: string;
}

const collection = (found: number, features: unknown[]) =>
  ({type: 'FeatureCollection', properties: {ResponseMetaData: {SearchResponse: {found}}}, features});

const feature = (o: FakeOrg) => ({
  type: 'Feature',
  geometry: {type: 'Point', coordinates: [o.lon, o.lat]},
  properties: {
    name: o.name ?? `Орг ${o.id}`,
    CompanyMetaData: {
      id: o.id,
      name: o.name ?? `Орг ${o.id}`,
      address: `ул. Тестовая, ${o.id}`,
      url: `https://${o.id}.example`,
      Phones: [{type: 'phone', formatted: '+7 (843) 200-00-00'}],
      Categories: [{class: 'x', name: 'Категория'}],
      Hours: {text: 'ежедневно, 9:00–18:00'},
    },
  },
});

/**
 * Stands in for search-maps.yandex.ru: filters orgs by text and bbox and,
 * like the real API, returns nothing past `cap` results. The page at
 * `shortAt` comes back one feature short.
 */
function fakeYandex(orgs: FakeOrg[], opts: {cap?: number; failFrom?: number; status?: number; body?: string; shortAt?: number} = {}) {
  const calls: URLSearchParams[] = [];
  const fakeFetch = (async (input: string | URL) => {
    const q = new URL(String(input)).searchParams;
    calls.push(q);
    if (opts.failFrom !== undefined && calls.length >= opts.failFrom) return new Response(opts.body ?? '{}', {status: opts.status ?? 403});
    if (q.get('type') === 'geo') {
      return Response.json(collection(1, [{type: 'Feature', geometry: {type: 'Point', coordinates: [49.1, 55.8]}, properties: {name: q.get('text'), boundedBy: CITY}}]));
    }
    const [[x1, y1], [x2, y2]] = q.get('bbox')!.split('~').map(c => c.split(',').map(Number));
    const hits = orgs.filter(o => o.tags.includes(q.get('text')!) && o.lon >= x1 && o.lon <= x2 && o.lat >= y1 && o.lat <= y2);
    const skip = Number(q.get('skip'));
    const end = Math.min(skip + Number(q.get('results')) - (skip === opts.shortAt ? 1 : 0), opts.cap ?? 1000);
    return Response.json(collection(hits.length, hits.slice(skip, end).map(feature)));
  }) as typeof globalThis.fetch;
  return {fetch: fakeFetch, calls};
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yandex-contacts-'));
});
afterEach(async () => {
  await rm(dir, {recursive: true, force: true});
});

const api = (fetch: typeof globalThis.fetch, over: Partial<ConstructorParameters<typeof YandexApi>[0]> = {}) =>
  new YandexApi({apiKey: KEY, cacheDir: join(dir, 'cache'), fetch, ...over});

/** Rows of a written CSV, checking the BOM and that every row ends with CRLF. */
async function readCsv(file: string) {
  const text = await readFile(file, 'utf8');
  expect(text.startsWith('﻿')).toBe(true);
  expect(text.endsWith('\r\n')).toBe(true);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 1; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') cell += text[i++];
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ';') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      rows.push([...row, cell]);
      row = [];
      cell = '';
      i++;
    } else cell += c;
  }
  return rows;
}

describe('parseResponse', () => {
  it('reads organizations and skips features without company data', () => {
    const page = parseResponse(collection(7, [
      feature({id: '123', lon: 49.12, lat: 55.79, tags: [], name: 'Кафе "Ёлка"'}),
      {type: 'Feature', geometry: {type: 'Point', coordinates: [1, 2]}, properties: {name: 'Топоним'}},
    ]));
    expect(page.found).toBe(7);
    expect(page.count).toBe(2);
    expect(page.orgs).toEqual<Org[]>([{
      id: '123', name: 'Кафе "Ёлка"', phones: ['+7 (843) 200-00-00'], url: 'https://123.example',
      address: 'ул. Тестовая, 123', categories: ['Категория'], hours: 'ежедневно, 9:00–18:00', lat: 55.79, lon: 49.12,
    }]);
  });

  it('tolerates missing fields and reads boundedBy', () => {
    const page = parseResponse(collection(1, [{properties: {boundedBy: CITY, CompanyMetaData: {id: 5, Phones: 'x'}}}]));
    expect(page.bounds).toEqual(CITY);
    expect(page.orgs[0]).toMatchObject({id: '5', name: '', phones: [], lat: null, lon: null});
    expect(() => parseResponse({error: 'nope'})).toThrow(/features/);
  });
});

describe('bbox', () => {
  it('parses, normalizes and splits into quarters', () => {
    expect(parseBBox('49.4,55.9~49,55.7')).toEqual(CITY);
    expect(() => parseBBox('49,55')).toThrow(/bbox/);
    expect(() => parseBBox('a,b~c,d')).toThrow(/bbox/);
    expect(splitBBox([[0, 0], [2, 2]])).toEqual([
      [[0, 0], [1, 1]], [[1, 0], [2, 1]], [[0, 1], [1, 2]], [[1, 1], [2, 2]],
    ]);
  });
});

describe('searchArea', () => {
  // 5×5 grid; the middle row and column lie on the quarter borders and come back twice.
  const grid: FakeOrg[] = [0.1, 0.3, 0.5, 0.7, 0.9].flatMap((x, i) =>
    [0.1, 0.3, 0.5, 0.7, 0.9].map((y, j) => ({id: `${i}${j}`, lon: x, lat: y, tags: ['кафе']})));
  const box: BBox = [[0, 0], [1, 1]];

  it('quarters an area that hits the ceiling and dedupes by id', async () => {
    const {fetch, calls} = fakeYandex(grid, {cap: 10});
    const res = new NicheResults();
    const complete = await searchArea(api(fetch), 'кафе', box, orgs => res.add(orgs, 'кафе'), {pageSize: 4, cap: 10});
    expect(complete).toBe(true);
    expect(res.rows.map(r => r.id).sort()).toEqual(grid.map(o => o.id).sort());
    expect(new Set(calls.map(q => q.get('bbox')))).toEqual(new Set(['0,0~1,1', ...splitBBox(box).map(b => `${b[0]}~${b[1]}`)]));
    expect(calls.every(q => q.get('rspn') === '1' && q.get('type') === 'biz' && q.get('lang') === 'ru_RU')).toBe(true);
    // 9 per quarter with 4 per page: skip 0, 4, 8.
    expect(calls.filter(q => q.get('bbox') === '0,0~0.5,0.5').map(q => q.get('skip'))).toEqual(['0', '4', '8']);
  });

  const pile = (n: number, tag: string, lon = 0.5, lat = 0.5): FakeOrg[] =>
    Array.from({length: n}, (_, i) => ({id: `p${i}`, lon, lat, tags: [tag]}));

  it('keeps paging past a short page until found is reached', async () => {
    const {fetch, calls} = fakeYandex(pile(300, 'кафе'), {shortAt: 50});
    const res = new NicheResults();
    expect(await searchArea(api(fetch), 'кафе', box, orgs => res.add(orgs, 'кафе'))).toBe(true);
    expect(calls.map(q => q.get('skip'))).toEqual(['0', '50', '100', '150', '200', '250']);
    // Everything the API returned: all but the one the short page left out.
    expect(res.rows).toHaveLength(299);
  });

  it('reports a cut list when pages run out before found', async () => {
    const {fetch, calls} = fakeYandex(pile(800, 'кафе'), {cap: 500});
    const res = new NicheResults();
    expect(await searchArea(api(fetch), 'кафе', box, orgs => res.add(orgs, 'кафе'))).toBe(false);
    expect(res.rows).toHaveLength(500);
    expect(calls.map(q => q.get('skip')).at(-1)).toBe('500');
  });

  it('reports a cut list when the depth limit is reached', async () => {
    const {fetch, calls} = fakeYandex(grid, {cap: 10});
    const res = new NicheResults();
    const complete = await searchArea(api(fetch), 'кафе', box, orgs => res.add(orgs, 'кафе'), {pageSize: 4, cap: 10, maxDepth: 0});
    expect(complete).toBe(false);
    expect(res.rows).toHaveLength(10);
    expect(calls.map(q => q.get('skip'))).toEqual(['0', '4', '8']);
  });

  it('keeps one row per organization and every query that found it', () => {
    const res = new NicheResults();
    const org = parseResponse(collection(1, [feature({id: '1', lon: 1, lat: 1, tags: []})])).orgs;
    res.add(org, 'электрик');
    res.add(org, 'сантехник');
    res.add(org, 'электрик');
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].queries).toEqual(['электрик', 'сантехник']);
  });
});

describe('csv', () => {
  it('escapes separators, quotes and line breaks, and guards formulas', () => {
    expect(csvCell('просто')).toBe('просто');
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('Кафе "Ёлка"')).toBe('"Кафе ""Ёлка"""');
    expect(csvCell('две\nстроки')).toBe('"две\nстроки"');
    expect(csvCell('+7 (843) 200-00-00, 8 800 555-35-35')).toBe('+7 (843) 200-00-00, 8 800 555-35-35');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-2+cmd|x')).toBe("'-2+cmd|x");
  });

  it('starts with a BOM and a header row', () => {
    const text = toCsv([['a', 'b;c']]);
    expect(text.startsWith('﻿Название;Телефоны;Сайт;')).toBe(true);
    expect(text.endsWith('\r\na;"b;c"\r\n')).toBe(true);
  });

  it('makes file names safe', () => {
    expect(nicheFileName(NICHES.find(n => n.code === '01-04')!)).toBe('01-04 Электрики, сантехники, отопление и водоснабжение.csv');
    expect(safeFileName('a/b\\c:d*e?"f"<g>|h. ')).toBe('a b c d e f g h');
    expect(safeFileName('Набережные Челны')).toBe('Набережные Челны');
    expect(safeFileName('CON')).toBe('_CON');
    expect(safeFileName('///')).toBe('_');
    expect(safeFileName('я'.repeat(300))).toHaveLength(150);
    const names = NICHES.map(nicheFileName);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toBe(safeFileName(n));
  });
});

describe('niches', () => {
  it('lists every niche once, with the workshops as their own group', () => {
    expect(NICHES).toHaveLength(61);
    expect(NICHES.every(n => n.title && n.queries.length)).toBe(true);
    expect(NICHES.find(n => n.title.startsWith('Мастерские'))).toMatchObject({code: '10-01', group: 'Мастерские и ремёсла'});
    expect(NICHES.filter(n => n.group === 'Туризм и гостеприимство')).toHaveLength(4);
  });

  it('selects by code, group number or name', () => {
    expect(selectNiches(['4-2']).map(n => n.code)).toEqual(['04-02']);
    expect(selectNiches(['01-04', '1.4']).map(n => n.code)).toEqual(['01-04']);
    expect(selectNiches(['5']).map(n => n.code)).toEqual(['05-01', '05-02', '05-03', '05-04']);
    expect(selectNiches(['СЕПТИК']).map(n => n.code)).toEqual(['01-08']);
    expect(selectNiches(['ремесла']).map(n => n.code)).toEqual(['10-01']);
    expect(selectNiches([])).toBe(NICHES);
    expect(() => selectNiches(['нет такой'])).toThrow(/не найдена/);
  });
});

describe('main', () => {
  const orgs: FakeOrg[] = [
    {id: '1', lon: 49.1, lat: 55.8, tags: ['электрик', 'сантехник'], name: 'Свет; и "вода"'},
    {id: '2', lon: 49.2, lat: 55.75, tags: ['сантехник']},
    {id: '3', lon: 49.3, lat: 55.85, tags: ['кровельные работы']},
    {id: '9', lon: 60, lat: 60, tags: ['электрик']},
  ];

  async function run(argv: string[], fetch: typeof globalThis.fetch, env: Record<string, string> = {YANDEX_SEARCH_API_KEY: KEY}) {
    const out: string[] = [];
    const err: string[] = [];
    const sleeps: number[] = [];
    const code = await main(['--out', join(dir, 'out'), ...argv], {
      env, fetch, log: m => out.push(m), error: m => err.push(m), sleep: async ms => void sleeps.push(ms),
    });
    return {code, out: out.join('\n'), err: err.join('\n'), sleeps};
  }

  const files = async () => (await readdir(join(dir, 'out'))).filter(f => f.endsWith('.csv')).sort();

  it('writes one file per selected niche and serves a rerun from the cache', async () => {
    const yandex = fakeYandex(orgs);
    const first = await run(['--city', 'Казань', '--niche', '01-04', '--niche', 'кровел', '--delay', '10'], yandex.fetch);
    expect(first.err).toBe('');
    expect(first.code).toBe(0);
    expect(await files()).toEqual([
      '01-03 Кровельные и фасадные работы.csv',
      '01-04 Электрики, сантехники, отопление и водоснабжение.csv',
    ]);
    const file = join(dir, 'out', '01-04 Электрики, сантехники, отопление и водоснабжение.csv');
    expect(await readFile(file, 'utf8')).toContain('\r\n"Свет; и ""вода""";+7');
    const rows = await readCsv(file);
    expect(rows).toHaveLength(3);
    expect(rows[0][0]).toBe('Название');
    expect(rows[1]).toEqual([
      'Свет; и "вода"', '+7 (843) 200-00-00', 'https://1.example', 'ул. Тестовая, 1', 'Категория',
      'ежедневно, 9:00–18:00', '55.8', '49.1', '1', 'https://yandex.ru/maps/org/1', 'электрик, сантехник',
    ]);
    expect(rows[2][8]).toBe('2');

    // geo + 2 queries for 01-03 + 4 for 01-04; a pause before each but the first.
    expect(yandex.calls).toHaveLength(7);
    expect(yandex.calls[0].get('type')).toBe('geo');
    expect(yandex.calls.every(q => q.get('apikey') === KEY)).toBe(true);
    expect(first.sleeps).toEqual(Array(6).fill(10));
    expect(first.out).not.toContain(KEY);

    const cacheDir = join(dir, 'out', '.cache');
    for (const f of await readdir(cacheDir)) expect(await readFile(join(cacheDir, f), 'utf8')).not.toContain(KEY);

    const offline = fakeYandex([], {failFrom: 1, status: 500});
    const second = await run(['--city', 'Казань', '--niche', '1-3', '--niche', '1-4'], offline.fetch);
    expect(second.code).toBe(0);
    expect(offline.calls).toHaveLength(0);
    expect(second.sleeps).toEqual([]);
    expect(second.out).toContain('Запросов к API: 0, из кеша: 7.');
    expect(await readCsv(file)).toEqual(rows);
  });

  it('writes a header-only file for a niche with no results', async () => {
    const {fetch} = fakeYandex(orgs);
    expect((await run(['--city', 'Казань', '--niche', 'автоподбор'], fetch)).code).toBe(0);
    const rows = await readCsv(join(dir, 'out', '03-06 Автоподбор.csv'));
    expect(rows).toHaveLength(1);
  });

  for (const status of [403, 429]) {
    it(`stops on ${status}, keeps what it collected and resumes later`, async () => {
      // Calls: geo, 01-03 ×2, then 01-04 «электрик» succeeds and «сантехник» fails.
      const limited = fakeYandex(orgs, {failFrom: 5, status});
      const first = await run(['--city', 'Казань', '--niche', '01-03', '--niche', '01-04', '--niche', '01-05'], limited.fetch);
      expect(first.code).toBe(2);
      expect(first.err).toContain(`API ответил ${status}`);
      expect(first.err).toContain('Запустите ту же команду');
      expect(first.out).toContain('Не завершены ниши: 01-04, 01-05.');
      expect(await files()).toEqual([
        '01-03 Кровельные и фасадные работы.csv',
        '01-04 Электрики, сантехники, отопление и водоснабжение.csv',
      ]);
      expect(await readCsv(join(dir, 'out', '01-03 Кровельные и фасадные работы.csv'))).toHaveLength(2);
      const partial = await readCsv(join(dir, 'out', '01-04 Электрики, сантехники, отопление и водоснабжение.csv'));
      expect(partial.map(r => r[8])).toEqual(['ID Яндекса', '1']);

      const ok = fakeYandex(orgs);
      const second = await run(['--city', 'Казань', '--niche', '01-03', '--niche', '01-04', '--niche', '01-05'], ok.fetch);
      expect(second.code).toBe(0);
      // Only the failed request and what came after it: 3 more for 01-04, 3 for 01-05.
      expect(ok.calls.map(q => q.get('text'))).toEqual([
        'сантехник', 'монтаж отопления', 'водоснабжение', 'установка окон', 'установка дверей', 'натяжные потолки',
      ]);
      const full = await readCsv(join(dir, 'out', '01-04 Электрики, сантехники, отопление и водоснабжение.csv'));
      expect(full.map(r => r[8])).toEqual(['ID Яндекса', '1', '2']);
    });
  }

  it('exits 1 on a rejected request, showing the body without the key', async () => {
    const body = JSON.stringify({statusCode: 400, error: 'Bad Request', message: `Invalid parameter: results, apikey=${KEY}`});
    const rejected = fakeYandex(orgs, {failFrom: 5, status: 400, body});
    const res = await run(['--city', 'Казань', '--niche', '01-03', '--niche', '01-04', '--page-size', '500'], rejected.fetch);
    expect(res.code).toBe(1);
    expect(res.err).toContain('API отклонил запрос (400)');
    expect(res.err).toContain('Invalid parameter: results, apikey=***');
    expect(res.err).toContain('--page-size');
    expect(res.err + res.out).not.toContain(KEY);
    expect(res.out).toContain('Не завершены ниши: 01-04.');
    expect(await readCsv(join(dir, 'out', '01-03 Кровельные и фасадные работы.csv'))).toHaveLength(2);
    const partial = await readCsv(join(dir, 'out', '01-04 Электрики, сантехники, отопление и водоснабжение.csv'));
    expect(partial.map(r => r[8])).toEqual(['ID Яндекса', '1']);
  });

  it('exits 2 on a server error so a rerun can retry', async () => {
    const failing = fakeYandex(orgs, {failFrom: 2, status: 500, body: 'oops'});
    const res = await run(['--city', 'Казань', '--niche', '01-03'], failing.fetch);
    expect(res.code).toBe(2);
    expect(res.err).toContain('API ответил 500');
    expect(res.err).toContain('Проверьте сеть. Запустите ту же команду снова');
  });

  it('stops at --max-requests and continues on the next run', async () => {
    const yandex = fakeYandex(orgs);
    const first = await run(['--city', 'Казань', '--niche', '01-04', '--max-requests', '2'], yandex.fetch);
    expect(first.code).toBe(2);
    expect(first.err).toContain('--max-requests');
    expect(yandex.calls).toHaveLength(2);
    const second = await run(['--city', 'Казань', '--niche', '01-04', '--max-requests', '3'], yandex.fetch);
    expect(second.code).toBe(0);
    expect(yandex.calls).toHaveLength(5);
  });

  it('uses --bbox instead of looking the city up', async () => {
    const yandex = fakeYandex(orgs);
    expect((await run(['--city', 'Казань', '--niche', '01-03', '--bbox', '49.4,55.9~49,55.7'], yandex.fetch)).code).toBe(0);
    expect(yandex.calls.map(q => q.get('bbox'))).toEqual(['49,55.7~49.4,55.9', '49,55.7~49.4,55.9']);
  });

  it('lists niches without a key or network', async () => {
    const yandex = fakeYandex([], {failFrom: 1});
    const res = await run(['--list'], yandex.fetch, {});
    expect(res.code).toBe(0);
    expect(res.out).toContain('10 Мастерские и ремёсла');
    expect(res.out).toContain('01-04  Электрики, сантехники, отопление и водоснабжение');
    expect(yandex.calls).toHaveLength(0);
  });

  it('marks a niche truncated when pages run out early, with a custom page size', async () => {
    const many = Array.from({length: 800}, (_, i) => ({id: `e${i}`, lon: 49.2, lat: 55.8, tags: ['электрик']}));
    const yandex = fakeYandex(many, {cap: 500});
    const res = await run(['--city', 'Казань', '--niche', '01-04', '--page-size', '100'], yandex.fetch);
    expect(res.code).toBe(0);
    expect(res.out).toContain('Внимание: в нишах 01-04');
    const electric = yandex.calls.filter(q => q.get('text') === 'электрик');
    expect(electric.map(q => q.get('skip'))).toEqual(['0', '100', '200', '300', '400', '500']);
    expect(electric.every(q => q.get('results') === '100')).toBe(true);
    expect(await readCsv(join(dir, 'out', '01-04 Электрики, сантехники, отопление и водоснабжение.csv'))).toHaveLength(501);
  });

  it('rejects bad arguments', async () => {
    const {fetch} = fakeYandex(orgs);
    expect((await run(['--city', 'Казань'], fetch, {})).err).toContain('YANDEX_SEARCH_API_KEY');
    expect((await run([], fetch)).code).toBe(1);
    expect((await run(['--city', 'Казань', '--niche', 'нет такой'], fetch)).err).toContain('не найдена');
    expect((await run(['--city', 'Казань', '--delay', '-1'], fetch)).code).toBe(1);
    for (const size of ['0', '501', 'abc', '1.5']) {
      expect((await run(['--city', 'Казань', '--page-size', size], fetch)).err).toContain('--page-size');
    }
    expect((await run(['--city', 'Казань', '--bogus'], fetch)).code).toBe(1);
  });
});
