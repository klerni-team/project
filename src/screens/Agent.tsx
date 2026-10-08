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
import {useChat} from '../lib/chat.tsx';
import {useStore} from '../lib/store.tsx';

const SUGGESTIONS: {label: string; prompt: string}[] = [
  {label: 'Спланируй мой день', prompt: 'Спланируй мой сегодняшний день: работа, спорт и время на себя.'},
  {label: 'Перенеси несделанное', prompt: 'Перенеси невыполненные задачи на завтра.'},
  {label: 'Итоги недели', prompt: 'Подведи итоги недели по привычкам.'},
  {label: 'Встрой утреннюю пробежку', prompt: 'Хочу начать бегать по утрам три раза в неделю, помоги встроить это в расписание.'},
];

export function Agent({draft, onDraftConsumed}: {draft: string; onDraftConsumed: () => void}) {
  const {password} = useStore();
  const {turns, pending, error, retryText, clearRetry, send: sendChat, clear} = useChat();
  const [input, setInput] = useState(draft);

  useEffect(() => {
    if (draft) {
      setInput(draft);
      onDraftConsumed();
    }
  }, [draft, onDraftConsumed]);

  // A failed send puts its text back once so it can be resent as is; a
  // draft handed over from another screen takes priority.
  useEffect(() => {
    if (!retryText) return;
    if (!draft) setInput(retryText);
    clearRetry();
  }, [retryText, draft, clearRetry]);

  const send = (text: string) => {
    if (!text.trim() || pending) return;
    setInput('');
    void sendChat(text);
  };

  const header = (
    <LayoutHeader hasDivider>
      <HStack gap={2} vAlign="center">
        <StackItem size="fill">
          <Heading level={1}>Агент</Heading>
        </StackItem>
        {turns.length > 0 && (
          <Button label="Новый чат" variant="ghost" size="sm" onClick={clear} isDisabled={pending} />
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
                onSubmit={send}
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
                    <Button key={s.label} label={s.label} variant="secondary" width="100%" onClick={() => send(s.prompt)} />
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
