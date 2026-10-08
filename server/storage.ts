import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {mergeStates, sanitizeState} from '../shared/state.ts';
import {emptyState, type AppState} from '../shared/types.ts';

/**
 * Single-user JSON store. Writes go to a temp file then rename, so a crash
 * mid-write never leaves a truncated state.json. All mutations run through
 * one promise chain, so concurrent requests cannot interleave read-modify-write.
 */
export class Storage {
  private readonly file: string;
  private readonly dir: string;
  private state: AppState | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.dir = dir;
    this.file = join(dir, 'state.json');
  }

  private async load(): Promise<AppState> {
    if (this.state) return this.state;
    try {
      this.state = sanitizeState(JSON.parse(await readFile(this.file, 'utf8')));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      this.state = emptyState();
    }
    return this.state;
  }

  private async save(next: AppState): Promise<void> {
    await mkdir(this.dir, {recursive: true});
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(next));
    await rename(tmp, this.file);
    this.state = next;
  }

  read(): Promise<AppState> {
    return this.serial(() => this.load());
  }

  /** Runs `fn` on the current state and persists what it returns. */
  update(fn: (s: AppState) => AppState | Promise<AppState>): Promise<AppState> {
    return this.serial(async () => {
      const next = await fn(await this.load());
      await this.save(next);
      return next;
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
