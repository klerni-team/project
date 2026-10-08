import {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {toISODate, toISOTime} from '../../shared/dates.ts';
import type {AgentAction, ChatTurn} from '../../shared/types.ts';
import {ApiError, askAgent} from './api.ts';
import {KEYS, load, save} from './storage.ts';
import {useStore} from './store.tsx';

export interface StoredTurn extends ChatTurn {
  actions?: AgentAction[];
}

interface Chat {
  turns: StoredTurn[];
  pending: boolean;
  error: string | null;
  /** Text restored into the composer after a failed send. */
  retryText: string;
  send: (text: string) => Promise<void>;
  clear: () => void;
}

/** Older turns are trimmed; the server also caps what it sends to the model. */
const MAX_STORED = 60;

const ChatCtx = createContext<Chat | null>(null);

export function useChat(): Chat {
  const c = useContext(ChatCtx);
  if (!c) throw new Error('useChat outside ChatProvider');
  return c;
}

function isStoredTurn(v: unknown): v is StoredTurn {
  const t = v as StoredTurn;
  return !!t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string';
}

/**
 * Chat lives above the tabs so a reply that arrives after the user left
 * the Agent screen is still recorded.
 */
export function ChatProvider({children}: {children: ReactNode}) {
  const {password, applyRemote, syncNow} = useStore();
  const [turns, setTurns] = useState<StoredTurn[]>(() => {
    const raw = load<unknown>(KEYS.chat, []);
    return Array.isArray(raw) ? raw.filter(isStoredTurn) : [];
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryText, setRetryText] = useState('');
  // Same text resent after a failure reuses the id, so the server can
  // answer from the first run instead of applying the changes twice.
  const lastFailed = useRef<{text: string; id: string} | null>(null);

  useEffect(() => save(KEYS.chat, turns.slice(-MAX_STORED)), [turns]);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || pending) return;
      const requestId = lastFailed.current?.text === content ? lastFailed.current.id : crypto.randomUUID();
      const history = [...turns, {role: 'user' as const, content}];
      setTurns(history);
      setError(null);
      setRetryText('');
      setPending(true);
      try {
        // The agent reads the server copy, so push local edits first.
        await syncNow();
        const now = new Date();
        const res = await askAgent(password, {
          requestId,
          messages: history.map(({role, content}) => ({role, content})),
          today: toISODate(now),
          now: toISOTime(now),
        });
        lastFailed.current = null;
        applyRemote(res.changes);
        setTurns(t => [...t, {role: 'assistant', content: res.reply, actions: res.actions}]);
      } catch (err) {
        lastFailed.current = {text: content, id: requestId};
        setError(err instanceof ApiError || err instanceof Error ? err.message : 'Что-то пошло не так');
        setTurns(t => (t.at(-1)?.role === 'user' && t.at(-1)?.content === content ? t.slice(0, -1) : t));
        setRetryText(content);
      } finally {
        setPending(false);
      }
    },
    [turns, pending, password, syncNow, applyRemote],
  );

  const value = useMemo<Chat>(
    () => ({
      turns,
      pending,
      error,
      retryText,
      send,
      clear: () => {
        setTurns([]);
        setError(null);
      },
    }),
    [turns, pending, error, retryText, send],
  );

  return <ChatCtx.Provider value={value}>{children}</ChatCtx.Provider>;
}
