import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {toISODate} from '../../shared/dates.ts';
import {
  changedSince,
  deleteHabit,
  deleteTask,
  isChecked,
  mergeStates,
  newId,
  sanitizeState,
  setCheck,
  TABLES,
  upsertHabit,
  upsertTask,
} from '../../shared/state.ts';
import {EVERY_DAY, type Challenge} from '../../shared/templates.ts';
import type {AppState, BaseRecord, Habit, ISODate, Task} from '../../shared/types.ts';
import {ApiError, syncState} from './api.ts';
import {KEYS, load, save} from './storage.ts';

/** `auth` and `locked` pause automatic sync until the password is re-entered. */
export type SyncStatus = 'off' | 'syncing' | 'ok' | 'offline' | 'auth' | 'locked';

interface SyncCursor {
  /** Server revision already pulled. */
  rev: number;
  /** Local edits stamped at or after this were not yet pushed. */
  pushedAt: number;
}

interface Store {
  state: AppState;
  today: ISODate;
  password: string;
  syncStatus: SyncStatus;
  setPassword: (p: string) => void;
  /** Push local edits and pull remote ones. Resolves when done (or failed). */
  syncNow: () => Promise<void>;
  /** Folds records from the server (sync or agent) into local state. */
  applyRemote: (changes: AppState) => void;
  /** Restores a backup: its records are re-stamped so they win over newer copies. */
  importBackup: (s: AppState) => void;
  toggleHabit: (habitId: string, date: ISODate) => void;
  saveTask: (t: Omit<Task, 'id' | 'updatedAt'> & {id?: string}) => void;
  toggleTask: (id: string) => void;
  removeTask: (id: string) => void;
  saveHabit: (h: Omit<Habit, 'id' | 'updatedAt' | 'createdAt' | 'startDate'> & {id?: string}) => void;
  removeHabit: (id: string) => void;
  addChallenge: (c: Challenge) => void;
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore outside StoreProvider');
  return s;
}

const SYNC_DEBOUNCE_MS = 800;
const SYNC_INTERVAL_MS = 60_000;
const FRESH_CURSOR: SyncCursor = {rev: 0, pushedAt: 0};

function useToday(): ISODate {
  const [today, setToday] = useState(() => toISODate(new Date()));
  useEffect(() => {
    const tick = () => setToday(toISODate(new Date()));
    const id = setInterval(tick, 30_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);
  return today;
}

function restamp(s: AppState, now: number): AppState {
  const out = {habits: {}, tasks: {}, checks: {}} as AppState;
  for (const t of TABLES) {
    for (const [id, r] of Object.entries(s[t] as Record<string, BaseRecord>)) {
      (out[t] as Record<string, BaseRecord>)[id] = {...r, updatedAt: now};
    }
  }
  return out;
}

export function StoreProvider({children}: {children: ReactNode}) {
  const [state, setState] = useState<AppState>(() => sanitizeState(load(KEYS.state, null)));
  const [password, setPasswordRaw] = useState(() => load(KEYS.password, ''));
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(password ? 'syncing' : 'off');
  const today = useToday();

  // Always-current copies for async callbacks.
  const stateRef = useRef(state);
  stateRef.current = state;
  const passwordRef = useRef(password);
  passwordRef.current = password;
  const statusRef = useRef(syncStatus);
  statusRef.current = syncStatus;
  const cursor = useRef<SyncCursor>(load(KEYS.sync, FRESH_CURSOR));
  const inFlight = useRef<Promise<void> | null>(null);
  const again = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => save(KEYS.state, state), [state]);

  const applyRemote = useCallback((changes: AppState) => {
    setState(cur => mergeStates(cur, sanitizeState(changes)));
  }, []);

  const runSync = useCallback(async (): Promise<void> => {
    const pw = passwordRef.current;
    if (!pw) return setSyncStatus('off');
    // One sync at a time; a request during a sync queues exactly one more.
    if (inFlight.current) {
      again.current = true;
      return inFlight.current;
    }
    const run = (async () => {
      setSyncStatus('syncing');
      const snapshotAt = Date.now();
      try {
        const res = await syncState(pw, {
          since: cursor.current.rev,
          changes: changedSince(stateRef.current, cursor.current.pushedAt),
        });
        if (passwordRef.current !== pw) return; // password changed mid-flight
        applyRemote(res.changes);
        cursor.current = {rev: res.rev, pushedAt: snapshotAt};
        save(KEYS.sync, cursor.current);
        setSyncStatus('ok');
      } catch (err) {
        const status = err instanceof ApiError ? err.status : 0;
        setSyncStatus(status === 401 ? 'auth' : status === 429 ? 'locked' : 'offline');
      }
    })();
    inFlight.current = run;
    try {
      await run;
    } finally {
      inFlight.current = null;
    }
    if (again.current) {
      again.current = false;
      await runSync();
    }
  }, [applyRemote]);

  /** Background sync: skipped while the password is known to be wrong or locked out. */
  const autoSync = useCallback(() => {
    if (statusRef.current === 'auth' || statusRef.current === 'locked') return;
    void runSync();
  }, [runSync]);

  const scheduleSync = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(autoSync, SYNC_DEBOUNCE_MS);
  }, [autoSync]);

  useEffect(() => {
    void runSync();
    const onVisible = () => document.visibilityState === 'visible' && autoSync();
    const id = setInterval(autoSync, SYNC_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, [runSync, autoSync, password]);

  /** Local edit: apply now, push to the server shortly after. */
  const edit = useCallback(
    (fn: (s: AppState) => AppState) => {
      setState(fn);
      scheduleSync();
    },
    [scheduleSync],
  );

  const store = useMemo<Store>(
    () => ({
      state,
      today,
      password,
      syncStatus,
      setPassword: p => {
        save(KEYS.password, p);
        // A different server or account: push everything, pull everything.
        cursor.current = FRESH_CURSOR;
        save(KEYS.sync, FRESH_CURSOR);
        setPasswordRaw(p);
      },
      syncNow: runSync,
      applyRemote,
      importBackup: s => edit(cur => mergeStates(cur, restamp(s, Date.now()))),
      toggleHabit: (habitId, date) =>
        edit(s => setCheck(s, habitId, date, !isChecked(s, habitId, date))),
      saveTask: ({id, ...rest}) =>
        edit(s => upsertTask(s, {...rest, id: id ?? newId(), updatedAt: Date.now()})),
      toggleTask: id =>
        edit(s => {
          const t = s.tasks[id];
          return t ? upsertTask(s, {...t, done: !t.done, updatedAt: Date.now()}) : s;
        }),
      removeTask: id => edit(s => deleteTask(s, id)),
      saveHabit: ({id, ...rest}) =>
        edit(s => {
          const now = Date.now();
          const prev = id ? s.habits[id] : undefined;
          return upsertHabit(s, {
            ...rest,
            id: id ?? newId(),
            startDate: prev?.startDate ?? today,
            createdAt: prev?.createdAt ?? now,
            updatedAt: now,
          });
        }),
      removeHabit: id => edit(s => deleteHabit(s, id)),
      addChallenge: c =>
        edit(s => {
          const now = Date.now();
          return c.habits.reduce(
            (acc, t) =>
              upsertHabit(acc, {
                id: newId(),
                name: t.name,
                emoji: t.emoji,
                days: t.days ?? EVERY_DAY,
                ...(t.time ? {time: t.time} : {}),
                ...(t.durationMin ? {durationMin: t.durationMin} : {}),
                challenge: c.id,
                startDate: today,
                createdAt: now,
                updatedAt: now,
              }),
            s,
          );
        }),
    }),
    [state, today, password, syncStatus, runSync, applyRemote, edit],
  );

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}
