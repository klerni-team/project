import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {mergeStates, sanitizeState, TABLES} from '../shared/state.ts';
import {emptyState, type AppState, type BaseRecord} from '../shared/types.ts';

type Revs = Record<(typeof TABLES)[number], Record<string, number>>;

interface Db {
  /**
   * Identity of this data set. A new file (fresh server, wiped volume) gets
   * a new epoch, which tells clients their cursors are meaningless here.
   */
  epoch: string;
  state: AppState;
  /** Server-side revision of each record, so devices can pull only what changed. */
  revs: Revs;
  rev: number;
}

const emptyRevs = (): Revs => ({habits: {}, tasks: {}, checks: {}});

function parseDb(raw: unknown): Db {
  const r = (raw ?? {}) as Partial<Db>;
  // Files written before revisions existed hold the bare state.
  const state = sanitizeState('state' in r ? r.state : raw);
  const revs = emptyRevs();
  const rev = typeof r.rev === 'number' && Number.isFinite(r.rev) ? r.rev : 1;
  for (const t of TABLES) {
    for (const id of Object.keys(state[t])) {
      const v = r.revs?.[t]?.[id];
      revs[t][id] = typeof v === 'number' ? v : rev;
    }
  }
  const epoch = typeof r.epoch === 'string' && r.epoch ? r.epoch : randomUUID();
  return {epoch, state, revs, rev};
}

/**
 * Single-user JSON store. Writes go to a temp file then rename, so a crash
 * mid-write never leaves a truncated file. All access runs through one
 * promise chain, so concurrent requests cannot interleave read-modify-write.
 */
export class Storage {
  private readonly file: string;
  private readonly dir: string;
  private db: Db | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.dir = dir;
    this.file = join(dir, 'state.json');
  }

  private async load(): Promise<Db> {
    if (this.db) return this.db;
    try {
      this.db = parseDb(JSON.parse(await readFile(this.file, 'utf8')));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      this.db = {epoch: randomUUID(), state: emptyState(), revs: emptyRevs(), rev: 0};
    }
    return this.db;
  }

  private async save(next: Db): Promise<void> {
    await mkdir(this.dir, {recursive: true});
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(next));
    await rename(tmp, this.file);
    this.db = next;
  }

  read(): Promise<AppState> {
    return this.serial(async () => (await this.load()).state);
  }

  /**
   * Replaces the state with `fn(state)`, giving every record whose object
   * changed a new revision. Returns the records that changed.
   */
  update(fn: (s: AppState) => AppState): Promise<AppState> {
    return this.serial(async () => {
      const db = await this.load();
      const next = fn(db.state);
      const revs: Revs = {habits: {...db.revs.habits}, tasks: {...db.revs.tasks}, checks: {...db.revs.checks}};
      const written = emptyState();
      let rev = db.rev;
      for (const t of TABLES) {
        const before = db.state[t] as Record<string, BaseRecord>;
        for (const [id, rec] of Object.entries(next[t] as Record<string, BaseRecord>)) {
          if (before[id] === rec) continue;
          revs[t][id] = ++rev;
          (written[t] as Record<string, BaseRecord>)[id] = rec;
        }
      }
      if (rev !== db.rev) await this.save({epoch: db.epoch, state: next, revs, rev});
      return written;
    });
  }

  /** Records with a revision above `since`, plus the current revision and epoch. */
  changesSince(since: number): Promise<{epoch: string; rev: number; changes: AppState}> {
    return this.serial(async () => {
      const db = await this.load();
      // A cursor ahead of the server means the data file was reset or
      // restored: send everything.
      const from = since > db.rev ? 0 : since;
      const changes = emptyState();
      for (const t of TABLES) {
        for (const [id, r] of Object.entries(db.revs[t])) {
          if (r > from) (changes[t] as Record<string, BaseRecord>)[id] = db.state[t][id];
        }
      }
      return {epoch: db.epoch, rev: db.rev, changes};
    });
  }

  merge(incoming: AppState): Promise<AppState> {
    return this.update(s => mergeStates(s, incoming));
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
