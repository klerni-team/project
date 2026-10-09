import {mkdir, rename, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {StopError, type BBox, type Org, type SearchPage, type YandexApi} from './api.ts';
import {nicheFileName, orgRow, toCsv, type Found} from './csv.ts';
import type {Niche} from './niches.ts';

/** Results per request unless --page-size says otherwise. */
export const PAGE_SIZE = 50;
/** Largest `results` the API documentation allows. */
export const MAX_PAGE_SIZE = 500;
/** The API returns at most about this many results for one query and area. */
export const RESULT_CAP = 1000;

export interface SearchLimits {
  /** Results per request. */
  pageSize?: number;
  /** The API returns at most this many results for one query and area. */
  cap?: number;
  /** How many times an area may be quartered. */
  maxDepth?: number;
}

export function splitBBox([[x1, y1], [x2, y2]]: BBox): BBox[] {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  return [
    [[x1, y1], [mx, my]], [[mx, y1], [x2, my]],
    [[x1, my], [mx, y2]], [[mx, my], [x2, y2]],
  ];
}

export const orgKey = (o: Org) => o.id || `${o.name}|${o.address}`;

/**
 * Feeds `add` every organization `text` finds in `bbox`. Areas that hit the
 * API ceiling are quartered and searched again: when `found` reaches `cap`,
 * and when, before `found` is reached, a page is rejected, a page after a
 * full one comes back empty, or a page holds nothing new (the real ceiling
 * is lower). Without `found`, pages are read until a short or empty one, and
 * reaching `cap` counts as the ceiling. Returns false when the list may be
 * cut: such an area was already at maximum depth, or even the first page was
 * empty.
 */
export async function searchArea(
  api: YandexApi, text: string, bbox: BBox, add: (orgs: Org[]) => void, limits: SearchLimits = {}, depth = 0,
): Promise<boolean> {
  const {pageSize = PAGE_SIZE, cap = RESULT_CAP, maxDepth = 4} = limits;
  const split = async () => {
    if (depth >= maxDepth) return false;
    let complete = true;
    for (const part of splitBBox(bbox)) {
      if (!await searchArea(api, text, part, add, limits, depth + 1)) complete = false;
    }
    return complete;
  };
  const first = await api.search({type: 'biz', text, bbox, results: pageSize, skip: 0});
  add(first.orgs);
  const {found} = first;
  if (found !== null && found >= cap && depth < maxDepth) return split();
  // An empty first page is complete only if nothing was found.
  if (!first.count) return !found;
  const end = Math.min(found ?? cap, cap);
  const seen = new Set(first.orgs.map(orgKey));
  let full = first.count >= pageSize;
  if (found === null && !full) return true;
  for (let skip = pageSize; skip < end; skip += pageSize) {
    const results = Math.min(pageSize, end - skip);
    let page: SearchPage;
    try {
      page = await api.search({type: 'biz', text, bbox, results, skip});
    } catch (err) {
      // The first page went through with the same key and page size, so the offset is what the API refused.
      if (!(err instanceof StopError && err.reason === 'request')) throw err;
      return split();
    }
    add(page.orgs);
    // Empty after a short page: `found` was overstated and the data simply ended.
    if (!page.count) return full && found !== null ? split() : true;
    const fresh = page.orgs.map(orgKey).filter(k => !seen.has(k));
    // Nothing new: past its real ceiling the API repeats a page instead of moving on.
    if (!fresh.length) return split();
    for (const k of fresh) seen.add(k);
    full = page.count >= results;
    if (found === null && !full) return true;
  }
  return found === null ? split() : found < cap;
}

/** Organizations of one niche, one entry per Yandex id. */
export class NicheResults {
  private readonly byKey = new Map<string, Found>();

  add(orgs: Org[], query: string) {
    for (const o of orgs) {
      const key = orgKey(o);
      const seen = this.byKey.get(key);
      if (!seen) this.byKey.set(key, {...o, queries: [query]});
      else if (!seen.queries.includes(query)) seen.queries.push(query);
    }
  }

  get rows(): Found[] {
    return [...this.byKey.values()];
  }
}

export async function findCity(api: YandexApi, city: string): Promise<BBox> {
  const page = await api.search({type: 'geo', text: city, results: 1, skip: 0});
  if (!page.bounds) throw new Error(`город «${city}» не найден, задайте область через --bbox`);
  return page.bounds;
}

async function writeAtomic(file: string, data: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

export interface CollectOptions {
  api: YandexApi;
  bbox: BBox;
  niches: Niche[];
  outDir: string;
  limits?: SearchLimits;
  log?: (msg: string) => void;
}

export interface CollectResult {
  /** Files written, completed niches first; a stopped niche's file holds what it got so far. */
  files: string[];
  /** Codes of niches that were not finished. */
  unfinished: string[];
  /** Codes of niches where some area still hit the result ceiling. */
  truncated: string[];
  stop: StopError | null;
}

/** Collects the niches in order, one CSV each; stops cleanly on quota, rate or budget limits. */
export async function collect(opts: CollectOptions): Promise<CollectResult> {
  const log = opts.log ?? (() => {});
  const result: CollectResult = {files: [], unfinished: [], truncated: [], stop: null};
  await mkdir(opts.outDir, {recursive: true});
  for (const [i, niche] of opts.niches.entries()) {
    const found = new NicheResults();
    let complete = true;
    let failure: unknown = null;
    log(`${niche.code} ${niche.title}`);
    for (const query of niche.queries) {
      try {
        const before = found.rows.length;
        if (!await searchArea(opts.api, query, opts.bbox, orgs => found.add(orgs, query), opts.limits)) complete = false;
        log(`  «${query}»: +${found.rows.length - before}`);
      } catch (err) {
        failure = err;
        break;
      }
    }
    const file = join(opts.outDir, nicheFileName(niche));
    await writeAtomic(file, toCsv(found.rows.map(orgRow)));
    result.files.push(file);
    if (!complete) result.truncated.push(niche.code);
    if (failure) {
      if (!(failure instanceof StopError)) throw failure;
      result.stop = failure;
      result.unfinished = opts.niches.slice(i).map(n => n.code);
      return result;
    }
    log(`  итого ${found.rows.length} → ${file}`);
  }
  return result;
}
