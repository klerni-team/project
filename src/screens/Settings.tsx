import {useEffect, useRef, useState} from 'react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Layout, LayoutContent, LayoutHeader} from '@astryxdesign/core/Layout';
import {List, ListItem} from '@astryxdesign/core/List';
import {HStack, VStack} from '@astryxdesign/core/Stack';
import {StatusDot} from '@astryxdesign/core/StatusDot';
import {Heading, Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {toISODate} from '../../shared/dates.ts';
import {sanitizeState} from '../../shared/state.ts';
import {health} from '../lib/api.ts';
import {KEYS, save} from '../lib/storage.ts';
import {useStore, type SyncStatus} from '../lib/store.tsx';

const STATUS: Record<SyncStatus, {label: string; variant: 'success' | 'warning' | 'error' | 'neutral' | 'accent'}> = {
  off: {label: 'Синхронизация выключена', variant: 'neutral'},
  syncing: {label: 'Синхронизирую…', variant: 'accent'},
  ok: {label: 'Синхронизировано', variant: 'success'},
  offline: {label: 'Сервер недоступен — данные сохранены на устройстве', variant: 'warning'},
  auth: {label: 'Неверный пароль', variant: 'error'},
};

export function SettingsScreen() {
  const {state, password, setPassword, syncStatus, syncNow, replaceAll} = useStore();
  const [value, setValue] = useState(password);
  const [agentOn, setAgentOn] = useState<boolean | null>(null);
  const [notice, setNotice] = useState<{status: 'success' | 'error'; text: string} | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void health().then(h => setAgentOn(h?.agent ?? null));
  }, []);

  const connect = () => {
    setPassword(value.trim());
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `habits-${toISODate(new Date())}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importJson = async (file: File) => {
    try {
      const next = sanitizeState(JSON.parse(await file.text()));
      const count = Object.keys(next.habits).length + Object.keys(next.tasks).length;
      if (count === 0) throw new Error('В файле нет привычек и задач');
      replaceAll(next);
      setNotice({status: 'success', text: `Загружено записей: ${count}`});
    } catch (err) {
      setNotice({status: 'error', text: err instanceof Error ? err.message : 'Не удалось прочитать файл'});
    }
  };

  const s = STATUS[syncStatus];

  return (
    <Layout
      height="fill"
      padding={4}
      contentWidth={640}
      header={
        <LayoutHeader hasDivider>
          <Heading level={1}>Настройки</Heading>
        </LayoutHeader>
      }
      content={
        <LayoutContent>
          <VStack gap={6}>
            {notice && (
              <Banner status={notice.status} title={notice.text} isDismissable onDismiss={() => setNotice(null)} collapsible={false} />
            )}

            <VStack>
              <VStack gap={3}>
                <Heading level={2}>Сервер</Heading>
                <Text type="supporting">
                  Пароль из переменной APP_PASSWORD на сервере. С ним iPhone и Mac видят одни и те же данные, и работает агент.
                </Text>
                <TextInput type="password" label="Пароль сервера" value={value} onChange={setValue} onEnter={connect} width="100%" autoComplete="current-password" />
                <HStack gap={2} vAlign="center" wrap="wrap">
                  <Button label="Подключить" variant="primary" onClick={connect} isDisabled={!value.trim() || value.trim() === password} />
                  <Button label="Синхронизировать сейчас" onClick={() => void syncNow()} isDisabled={!password} />
                </HStack>
                <HStack gap={2} vAlign="center">
                  <StatusDot variant={s.variant} label={s.label} />
                  <Text type="supporting">{s.label}</Text>
                </HStack>
                {agentOn === false && (
                  <Text type="supporting">На сервере не задан ANTHROPIC_API_KEY — агент выключен, остальное работает.</Text>
                )}
              </VStack>
            </VStack>

            <VStack>
              <VStack gap={3}>
                <Heading level={2}>Данные</Heading>
                <HStack gap={2} wrap="wrap">
                  <Button label="Скачать резервную копию" onClick={exportJson} />
                  <Button label="Загрузить из файла" onClick={() => fileRef.current?.click()} />
                  <Button
                    label="Очистить чат с агентом"
                    variant="ghost"
                    onClick={() => {
                      save(KEYS.chat, []);
                      setNotice({status: 'success', text: 'Чат очищен'});
                    }}
                  />
                </HStack>
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/json,.json"
                  hidden
                  onChange={e => {
                    const f = e.target.files?.[0];
                    if (f) void importJson(f);
                    e.target.value = '';
                  }}
                />
              </VStack>
            </VStack>

            <VStack>
              <VStack gap={2}>
                <Heading level={2}>Установка</Heading>
                <List listStyle="decimal" density="compact">
                  <ListItem label="iPhone: открой сайт в Safari → «Поделиться» → «На экран Домой»." />
                  <ListItem label="Mac: Safari → «Файл» → «Добавить в Dock» (или значок установки в Chrome)." />
                  <ListItem label="Введи пароль сервера на каждом устройстве один раз." />
                </List>
              </VStack>
            </VStack>
          </VStack>
        </LayoutContent>
      }
    />
  );
}
