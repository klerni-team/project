// localStorage can be unavailable (private mode, quota), so every access is guarded.

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the app keeps working in memory.
  }
}

export const KEYS = {
  state: 'habits.state.v1',
  password: 'habits.password.v1',
  /** {rev, pushedAt}: server cursor and the local watermark of pushed edits. */
  sync: 'habits.sync.v1',
  chat: 'habits.chat.v1',
} as const;
