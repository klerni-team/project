import {createHash} from 'node:crypto';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';

export const API_URL = 'https://search-maps.yandex.ru/v1/';

/** `[[lon1, lat1], [lon2, lat2]]`: south-west and north-east corners. */
export type BBox = [[number, number], [number, number]];

export interface Org {
  id: string;
  name: string;
  phones: string[];
  url: string;
  address: string;
  categories: string[];
  hours: string;
  lat: number | null;
  lon: number | null;
}

export interface SearchPage {
  /** null when the response does not say. */
  found: number | null;
  /** Features in the response, including any without company data. */
  count: number;
  orgs: Org[];
  /** `boundedBy` of the first feature (type=geo). */
  bounds: BBox | null;
}

export interface SearchParams {
  type: 'biz' | 'geo';
  text: string;
  bbox?: BBox;
  results: number;
  skip: number;
}

/** `request`: the API rejected the request itself, so repeating it will not help. */
export type StopReason = 'quota' | 'rate' | 'budget' | 'error' | 'request';

/** The run cannot go on now, but what was collected is valid and a rerun resumes from the cache. */
export class StopError extends Error {
  readonly reason: StopReason;
  constructor(reason: StopReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const str = (v: unknown) => typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;

function point(v: unknown): [number, number] | null {
  const [lon, lat] = arr(v).map(num);
  return lon === null || lat === null || lon === undefined || lat === undefined ? null : [lon, lat];
}

export function formatBBox([[lon1, lat1], [lon2, lat2]]: BBox): string {
  return `${lon1},${lat1}~${lon2},${lat2}`;
}

/** Parses `lon1,lat1~lon2,lat2` into a normalized box (south-west corner first). */
export function parseBBox(s: string): BBox {
  const corners = s.split('~').map(c => point(c.split(',').map(x => x.trim() === '' ? NaN : Number(x))));
  const [a, b] = corners;
  if (corners.length !== 2 || !a || !b || a[0] === b[0] || a[1] === b[1]) {
    throw new Error(`неверный bbox «${s}», нужен формат lon1,lat1~lon2,lat2`);
  }
  return [[Math.min(a[0], b[0]), Math.min(a[1], b[1])], [Math.max(a[0], b[0]), Math.max(a[1], b[1])]];
}

export function parseResponse(json: unknown): SearchPage {
  const root = obj(json);
  if (!Array.isArray(root.features)) throw new Error('в ответе API нет features');
  const meta = obj(obj(obj(root.properties).ResponseMetaData).SearchResponse);
  const orgs: Org[] = [];
  for (const f of root.features) {
    const props = obj(obj(f).properties);
    if (!('CompanyMetaData' in props)) continue;
    const c = obj(props.CompanyMetaData);
    const at = point(obj(obj(f).geometry).coordinates);
    orgs.push({
      id: str(c.id),
      name: str(c.name) || str(props.name),
      phones: arr(c.Phones).map(p => str(obj(p).formatted)).filter(Boolean),
      url: str(c.url),
      address: str(c.address) || str(props.description),
      categories: arr(c.Categories).map(x => str(obj(x).name)).filter(Boolean),
      hours: str(obj(c.Hours).text),
      lon: at?.[0] ?? null,
      lat: at?.[1] ?? null,
    });
  }
  const bounded = arr(obj(obj(root.features[0]).properties).boundedBy).map(point);
  const bounds: BBox | null = bounded.length === 2 && bounded[0] && bounded[1] ? [bounded[0], bounded[1]] : null;
  return {found: num(meta.found), count: root.features.length, orgs, bounds};
}

export interface ApiOptions {
  apiKey: string;
  /** Responses are stored here without the key, so a rerun does not spend quota on them again. */
  cacheDir: string;
  fetch?: typeof fetch;
  /** Pause before each network request after the first. */
  delayMs?: number;
  /** Network requests allowed for this instance; cache hits are free. */
  maxRequests?: number;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export class YandexApi {
  /** Network requests made so far. */
  requests = 0;
  cacheHits = 0;
  private readonly opts: ApiOptions;

  constructor(opts: ApiOptions) {
    this.opts = opts;
  }

  async search(p: SearchParams): Promise<SearchPage> {
    const query = new URLSearchParams({text: p.text, type: p.type, lang: 'ru_RU', results: String(p.results), skip: String(p.skip)});
    if (p.bbox) {
      query.set('bbox', formatBBox(p.bbox));
      query.set('rspn', '1');
    }
    const file = join(this.opts.cacheDir, `${createHash('sha256').update(query.toString()).digest('hex')}.json`);
    const cached = await readCache(file);
    if (cached !== undefined) {
      this.cacheHits++;
      return parseResponse(cached);
    }

    const {apiKey, maxRequests = Infinity, delayMs = 0} = this.opts;
    if (this.requests >= maxRequests) throw new StopError('budget', `исчерпан лимит --max-requests (${maxRequests})`);
    if (this.requests > 0 && delayMs > 0) await (this.opts.sleep ?? wait)(delayMs);
    this.requests++;
    const redact = (s: string) => apiKey.length >= 8 ? s.replaceAll(apiKey, '***') : s;
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(`${API_URL}?${new URLSearchParams({apikey: apiKey})}&${query}`);
    } catch (err) {
      const cause = (err as {cause?: unknown}).cause;
      throw new StopError('error', redact(`сеть недоступна: ${String(cause ?? err)}`));
    }
    if (res.status === 403) throw new StopError('quota', 'API ответил 403: ключ неверный или исчерпана суточная квота');
    if (res.status === 429) throw new StopError('rate', 'API ответил 429: слишком много запросов');
    if (res.status >= 400 && res.status < 500) {
      const body = redact((await res.text().catch(() => '')).replace(/\s+/g, ' ').trim()).slice(0, 300);
      throw new StopError('request', `API отклонил запрос (${res.status})${body ? `: ${body}` : ''}`);
    }
    if (!res.ok) throw new StopError('error', `API ответил ${res.status}`);
    let json: unknown;
    let page: SearchPage;
    try {
      json = await res.json();
      page = parseResponse(json);
    } catch (err) {
      throw new StopError('error', redact(`непонятный ответ API: ${(err as Error).message}`));
    }
    await writeCache(file, {query: query.toString(), response: json});
    return page;
  }
}

async function readCache(file: string): Promise<unknown> {
  try {
    return obj(JSON.parse(await readFile(file, 'utf8'))).response;
  } catch (err) {
    // A corrupt entry is fetched again.
    if (err instanceof SyntaxError) return undefined;
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return undefined;
  }
}

async function writeCache(file: string, entry: unknown) {
  await mkdir(dirname(file), {recursive: true});
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(entry));
  await rename(tmp, file);
}
