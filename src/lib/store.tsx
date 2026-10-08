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
  deleteHabit,
  deleteTask,
  isChecked,
  mergeStates,
  newId,
  sanitizeState,
  setCheck,
  upsertHabit,
  upsertTask,
} from '../../shared/state.ts';
import {EVERY_DAY, type Challenge} from '../../shared/templates.ts';
import type {AppState, Habit, ISODate, Task} from '../../shared/types.ts';
import {ApiError, syncState} from './api.ts';
import {KEYS, load, save} from './storage.ts';

export type SyncStatus = 'off' | 'syncing' | 'ok' | 'offline' | 'auth';

interface Store {
  state: AppState;
  today: ISODate;
  password: string;
  syncStatus: SyncStatus;
  setPassword: (p: string) => void;
  syncNow: () => Promise<void>;
  /** Folds a server response (sync or agent) into local state. */
  applyRemote: (s: AppState) => void;
  replaceAll: (s: AppState) => void;
  toggleHabit: (habitId: string, date: ISODate) => void;
  saveTask: (t: Omit<Task, 'id' | 'updatedAt'> & {id?: string}) => void;
  toggleTask: (id: string) => void;
  removeTask: (id: string) => void;
  saveHabit: (h: Omit<Habit, 'id' | 'updatedAt' | 'createdAt'> & {id?: string}) => void;
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
  const inFlight = useRef<Promise<void> | null>(null);
  const again = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => save(KEYS.state, state), [state]);

  const applyRemote = useCallback((remote: AppState) => {
    setState(cur => mergeStates(cur, sanitizeState(remote)));
  }, []);

  const syncNow = useCallback(async () => {
    const pw = passwordRef.current;
    if (!pw) return setSyncStatus('off');
    // One sync at a time; a request during a sync queues exactly one more.
    if (inFlight.current) {
      again.current = true;
      return inFlight.current;
    }
    const run = (async () => {
      setSyncStatus('syncing');
      try {
        applyRemote(await syncState(pw, stateRef.current));
        setSyncStatus('ok');
      } catch (err) {
        setSyncStatus(err instanceof ApiError && err.status === 401 ? 'auth' : 'offline');
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
      void syncNow();
    }
  }, [applyRemote]);

  const scheduleSync = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void syncNow(), SYNC_DEBOUNCE_MS);
  }, [syncNow]);

  useEffect(() => {
    void syncNow();
    const onVisible = () => document.visibilityState === 'visible' && void syncNow();
    const id = setInterval(() => void syncNow(), SYNC_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, [syncNow, password]);

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
        setPasswordRaw(p);
      },
      syncNow,
      applyRemote,
      replaceAll: s => edit(() => s),
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
          return upsertHabit(s, {...rest, id: id ?? newId(), createdAt: prev?.createdAt ?? now, updatedAt: now});
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
                createdAt: now,
                updatedAt: now,
              }),
            s,
          );
        }),
    }),
    [state, today, password, syncStatus, syncNow, applyRemote, edit],
  );

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}
