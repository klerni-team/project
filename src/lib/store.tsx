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
  adoptCorrections,
  changedSince,
  checkId,
  deleteHabit,
  deleteTask,
  isChecked,
  mergeStates,
  newId,
  nextStamp,
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
  /** Server data set the cursor belongs to. */
  epoch: string;
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
  /** Push local edits and pull remote ones. Resolves true when they reached the server. */
  syncNow: () => Promise<boolean>;
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
const FRESH_CURSOR: SyncCursor = {epoch: '', rev: 0, pushedAt: 0};

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
  const inFlight = useRef<Promise<boolean> | null>(null);
  const again = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => save(KEYS.state, state), [state]);

  const applyRemote = useCallback((changes: AppState) => {
    setState(cur => mergeStates(cur, sanitizeState(changes)));
  }, []);

  /** One push/pull round trip. Returns true when the cursor had to be reset. */
  const syncOnce = useCallback(async (pw: string): Promise<boolean> => {
    const snapshotAt = Date.now();
    const sent = cursor.current;
    const pushed = changedSince(stateRef.current, sent.pushedAt);
    const res = await syncState(pw, {since: sent.rev, changes: pushed});
    if (passwordRef.current !== pw) return false; // password changed mid-flight
    setState(cur =>
      adoptCorrections(mergeStates(cur, sanitizeState(res.changes)), pushed, sanitizeState(res.corrected)),
    );
    // A different data set (wiped volume, new server) or a rewound one
    // (restored backup): our pushed records may be missing there.
    const reset = sent.epoch !== '' && (res.epoch !== sent.epoch || res.rev < sent.rev);
    cursor.current = reset ? {...FRESH_CURSOR, epoch: res.epoch} : {epoch: res.epoch, rev: res.rev, pushedAt: snapshotAt};
    save(KEYS.sync, cursor.current);
    return reset;
  }, [applyRemote]);

  /**
   * Pushes local edits and pulls remote ones. A call during a running sync
   * queues one more pass and resolves only after it, so a caller that
   * awaits it knows whether its own edits reached the server.
   */
  const runSync = useCallback((): Promise<boolean> => {
    if (inFlight.current) {
      again.current = true;
      return inFlight.current;
    }
    const loop = (async () => {
      do {
        again.current = false;
        const pw = passwordRef.current;
        if (!pw) {
          setSyncStatus('off');
          return false;
        }
        setSyncStatus('syncing');
        try {
          if (await syncOnce(pw)) again.current = true;
          setSyncStatus('ok');
        } catch (err) {
          const status = err instanceof ApiError ? err.status : 0;
          setSyncStatus(status === 401 ? 'auth' : status === 429 ? 'locked' : 'offline');
          return false;
        }
      } while (again.current);
      return true;
    })().finally(() => {
      inFlight.current = null;
    });
    inFlight.current = loop;
    return loop;
  }, [syncOnce]);

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
        edit(s => setCheck(s, habitId, date, !isChecked(s, habitId, date), nextStamp(s.checks[checkId(habitId, date)]))),
      // Forms own their fields; `done` and deletion may have changed elsewhere
      // while the sheet was open, so those come from the current record.
      saveTask: ({id, ...rest}) =>
        edit(s => {
          const cur = id ? s.tasks[id] : undefined;
          return upsertTask(s, {
            ...rest,
            id: id ?? newId(),
            done: cur ? cur.done : rest.done,
            ...(cur?.deleted ? {deleted: true} : {}),
            updatedAt: nextStamp(cur),
          });
        }),
      toggleTask: id =>
        edit(s => {
          const t = s.tasks[id];
          return t ? upsertTask(s, {...t, done: !t.done, updatedAt: nextStamp(t)}) : s;
        }),
      removeTask: id => edit(s => deleteTask(s, id, nextStamp(s.tasks[id]))),
      saveHabit: ({id, ...rest}) =>
        edit(s => {
          const prev = id ? s.habits[id] : undefined;
          const now = nextStamp(prev);
          return upsertHabit(s, {
            ...rest,
            id: id ?? newId(),
            ...(prev?.deleted ? {deleted: true} : {}),
            startDate: prev?.startDate ?? today,
            createdAt: prev?.createdAt ?? now,
            updatedAt: now,
          });
        }),
      removeHabit: id => edit(s => deleteHabit(s, id, nextStamp(s.habits[id]))),
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
