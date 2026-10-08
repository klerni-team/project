import {useEffect, useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {
  ChatComposer,
  ChatLayout,
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  ChatToolCalls,
} from '@astryxdesign/core/Chat';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import {Layout, LayoutContent, LayoutHeader} from '@astryxdesign/core/Layout';
import {Markdown} from '@astryxdesign/core/Markdown';
import {Spinner} from '@astryxdesign/core/Spinner';
import {HStack, StackItem, VStack} from '@astryxdesign/core/Stack';
import {Heading} from '@astryxdesign/core/Text';
import {Sparkles} from 'lucide-react';
import {toISODate, toISOTime} from '../../shared/dates.ts';
import type {AgentAction, ChatTurn} from '../../shared/types.ts';
import {ApiError, askAgent} from '../lib/api.ts';
import {KEYS, load, save} from '../lib/storage.ts';
import {useStore} from '../lib/store.tsx';

interface StoredTurn extends ChatTurn {
  actions?: AgentAction[];
}

const SUGGESTIONS: {label: string; prompt: string}[] = [
  {label: 'Спланируй мой день', prompt: 'Спланируй мой сегодняшний день: работа, спорт и время на себя.'},
  {label: 'Перенеси несделанное', prompt: 'Перенеси невыполненные задачи на завтра.'},
  {label: 'Итоги недели', prompt: 'Подведи итоги недели по привычкам.'},
  {label: 'Встрой утреннюю пробежку', prompt: 'Хочу начать бегать по утрам три раза в неделю, помоги встроить это в расписание.'},
];

/** Older turns are trimmed; the server also caps what it sends to the model. */
const MAX_STORED = 60;

function isStoredTurn(v: unknown): v is StoredTurn {
  const t = v as StoredTurn;
  return !!t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string';
}

export function Agent({draft, onDraftConsumed}: {draft: string; onDraftConsumed: () => void}) {
  const {password, applyRemote} = useStore();
  const [turns, setTurns] = useState<StoredTurn[]>(() => {
    const raw = load<unknown>(KEYS.chat, []);
    return Array.isArray(raw) ? raw.filter(isStoredTurn) : [];
  });
  const [input, setInput] = useState(draft);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => save(KEYS.chat, turns.slice(-MAX_STORED)), [turns]);

  useEffect(() => {
    if (draft) {
      setInput(draft);
      onDraftConsumed();
    }
  }, [draft, onDraftConsumed]);

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || pending) return;
    const next = [...turns, {role: 'user' as const, content}];
    setTurns(next);
    setInput('');
    setError(null);
    setPending(true);
    try {
      const now = new Date();
      const res = await askAgent(password, {
        messages: next.map(({role, content}) => ({role, content})),
        today: toISODate(now),
        now: toISOTime(now),
      });
      applyRemote(res.state);
      setTurns(t => [...t, {role: 'assistant', content: res.reply, actions: res.actions}]);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? 'Неверный пароль сервера — проверь его в настройках'
          : err instanceof Error
            ? err.message
            : 'Что-то пошло не так',
      );
      // Put the text back so a failed request can be resent.
      setTurns(turns);
      setInput(content);
    } finally {
      setPending(false);
    }
  };

  const header = (
    <LayoutHeader hasDivider>
      <HStack gap={2} vAlign="center">
        <StackItem size="fill">
          <Heading level={1}>Агент</Heading>
        </StackItem>
        {turns.length > 0 && (
          <Button label="Новый чат" variant="ghost" size="sm" onClick={() => setTurns([])} isDisabled={pending} />
        )}
      </HStack>
    </LayoutHeader>
  );

  if (!password) {
    return (
      <Layout
        height="fill"
        header={header}
        content={
          <LayoutContent>
            <EmptyState
              title="Агент работает через твой сервер"
              description="Открой «Ещё» и введи пароль сервера. Ключ Claude хранится на сервере, а не в телефоне."
              icon={<Sparkles size={32} />}
              actions={<Button label="Открыть настройки" variant="primary" href="#settings" />}
            />
          </LayoutContent>
        }
      />
    );
  }

  return (
    <Layout
      height="fill"
      header={header}
      content={
        <LayoutContent padding={0} isScrollable={false}>
          <ChatLayout
            density="balanced"
            style={{height: '100%'}}
            composer={
              <ChatComposer
                value={input}
                onChange={setInput}
                onSubmit={v => void send(v)}
                placeholder="Что запланировать?"
                isDisabled={pending}
                status={error ? {type: 'error', message: error} : undefined}
              />
            }
            emptyState={
              <VStack gap={4} padding={4}>
                <EmptyState
                  title="Планировщик на Claude"
                  description="Расскажи, что нужно сделать, — агент разложит дела по времени с учётом привычек и сам внесёт их в план."
                  icon={<Sparkles size={32} />}
                />
                <VStack gap={2}>
                  {SUGGESTIONS.map(s => (
                    <Button key={s.label} label={s.label} variant="secondary" width="100%" onClick={() => void send(s.prompt)} />
                  ))}
                </VStack>
              </VStack>
            }>
            {turns.length > 0 && (
              <ChatMessageList isStreaming={pending}>
                {turns.map((t, i) =>
                  t.role === 'user' ? (
                    <ChatMessage key={i} sender="user">
                      <ChatMessageBubble>{t.content}</ChatMessageBubble>
                    </ChatMessage>
                  ) : (
                    <ChatMessage key={i} sender="assistant">
                      {t.actions && t.actions.length > 0 && (
                        <ChatToolCalls
                          label={`Изменений в плане: ${t.actions.length}`}
                          calls={t.actions.map(a => ({name: a.summary, status: 'complete' as const}))}
                        />
                      )}
                      <ChatMessageBubble variant="ghost">
                        <Markdown density="compact">{t.content}</Markdown>
                      </ChatMessageBubble>
                    </ChatMessage>
                  ),
                )}
                {pending && (
                  <ChatMessage sender="assistant">
                    <ChatMessageBubble variant="ghost">
                      <Spinner size="sm" label="Планирую…" />
                    </ChatMessageBubble>
                  </ChatMessage>
                )}
              </ChatMessageList>
            )}
          </ChatLayout>
        </LayoutContent>
      }
    />
  );
}
