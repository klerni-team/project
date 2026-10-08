import {useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput';
import {Divider} from '@astryxdesign/core/Divider';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import {IconButton} from '@astryxdesign/core/IconButton';
import {Item} from '@astryxdesign/core/Item';
import {Layout, LayoutContent, LayoutHeader} from '@astryxdesign/core/Layout';
import {List} from '@astryxdesign/core/List';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import {HStack, StackItem, VStack} from '@astryxdesign/core/Stack';
import {Heading, Text} from '@astryxdesign/core/Text';
import {ChevronLeft, ChevronRight, Pencil, Plus, Sparkles} from 'lucide-react';
import type {Navigate} from '../App.tsx';
import {addDays, formatDayTitle, parseISODate, toISOTime} from '../../shared/dates.ts';
import {currentStreak, dayProgress, habitsDueOn, isChecked, tasksOn} from '../../shared/state.ts';
import type {Habit, Task} from '../../shared/types.ts';
import {TaskSheet} from '../components/TaskSheet.tsx';
import {useStore} from '../lib/store.tsx';

type Row =
  | {kind: 'task'; key: string; time?: string; task: Task}
  | {kind: 'habit'; key: string; time?: string; habit: Habit};

function endTime(start: string, minutes?: number): string | null {
  if (!minutes) return null;
  const [h, m] = start.split(':').map(Number);
  const total = (h * 60 + m + minutes) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function timeLabel(time?: string, minutes?: number): string | null {
  if (!time) return minutes ? `${minutes} мин` : null;
  const end = endTime(time, minutes);
  return end ? `${time}–${end}` : time;
}

export function Today({navigate}: {navigate: Navigate}) {
  const {state, today, toggleHabit, toggleTask} = useStore();
  // An offset from today, so a screen left open overnight moves to the new day.
  const [offset, setOffset] = useState(0);
  const date = addDays(today, offset);
  const [editing, setEditing] = useState<Task | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const rows: Row[] = [
    ...habitsDueOn(state, date).map(h => ({kind: 'habit' as const, key: `h-${h.id}`, time: h.time, habit: h})),
    ...tasksOn(state, date).map(t => ({kind: 'task' as const, key: `t-${t.id}`, time: t.time, task: t})),
  ];
  const scheduled = rows.filter(r => r.time).sort((a, b) => a.time!.localeCompare(b.time!));
  const anytime = rows.filter(r => !r.time);
  const progress = dayProgress(state, date);
  const nowTime = toISOTime(new Date());
  // Where the "now" line goes: before the first block that starts later.
  const firstLater = scheduled.findIndex(r => r.time! > nowTime);
  const nowIndex = date !== today ? -1 : firstLater === -1 ? scheduled.length : firstLater;
  const nowLine = <Item key="now" as="li" density="compact" label={<Divider label={`Сейчас ${nowTime}`} variant="strong" />} />;

  const openNew = () => {
    setEditing(null);
    setSheetOpen(true);
  };

  const renderRow = (r: Row) => {
    if (r.kind === 'habit') {
      const done = isChecked(state, r.habit.id, date);
      const streak = currentStreak(state, r.habit, today);
      const meta = [timeLabel(r.habit.time, r.habit.durationMin), 'привычка', streak > 0 ? `🔥 ${streak}` : null]
        .filter(Boolean)
        .join(' · ');
      return (
        <Item
          key={r.key}
          as="li"
          density="spacious"
          startContent={
            <CheckboxInput
              label={r.habit.name}
              isLabelHidden
              value={done}
              onChange={() => toggleHabit(r.habit.id, date)}
            />
          }
          label={
            <Text hasStrikethrough={done} color={done ? 'secondary' : 'primary'}>
              {r.habit.emoji} {r.habit.name}
            </Text>
          }
          description={meta}
        />
      );
    }
    const t = r.task;
    return (
      <Item
        key={r.key}
        as="li"
        density="spacious"
        startContent={<CheckboxInput label={t.title} isLabelHidden value={t.done} onChange={() => toggleTask(t.id)} />}
        label={
          <Text hasStrikethrough={t.done} color={t.done ? 'secondary' : 'primary'}>
            {t.title}
          </Text>
        }
        description={[timeLabel(t.time, t.durationMin), t.notes].filter(Boolean).join(' · ') || undefined}
        endContent={
          <IconButton
            label={`Изменить «${t.title}»`}
            icon={<Pencil size={16} />}
            variant="ghost"
            size="sm"
            onClick={() => {
              setEditing(t);
              setSheetOpen(true);
            }}
          />
        }
      />
    );
  };

  const dateLine = parseISODate(date).toLocaleDateString('ru-RU', {weekday: 'long', day: 'numeric', month: 'long'});

  return (
    <Layout
      height="fill"
      padding={4}
      contentWidth={720}
      header={
        <LayoutHeader hasDivider>
          <VStack gap={3}>
            <HStack gap={2} vAlign="center">
              <IconButton label="Предыдущий день" icon={<ChevronLeft size={18} />} variant="ghost" onClick={() => setOffset(o => o - 1)} />
              <StackItem size="fill">
                <VStack gap={0.5}>
                  <Heading level={1}>{formatDayTitle(date, today)}</Heading>
                  {date === today && <Text type="supporting">{dateLine}</Text>}
                </VStack>
              </StackItem>
              {date !== today && <Button label="Сегодня" variant="ghost" size="sm" onClick={() => setOffset(0)} />}
              <IconButton label="Следующий день" icon={<ChevronRight size={18} />} variant="ghost" onClick={() => setOffset(o => o + 1)} />
              <IconButton label="Новая задача" icon={<Plus size={18} />} variant="primary" onClick={openNew} />
            </HStack>
            {progress.total > 0 && (
              <ProgressBar
                label="Выполнено за день"
                isLabelHidden
                hasValueLabel
                value={progress.done}
                max={progress.total}
                variant={progress.done === progress.total ? 'success' : 'accent'}
                formatValueLabel={(v, m) => `${v} из ${m}`}
              />
            )}
          </VStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent>
          {rows.length === 0 ? (
            <EmptyState
              title="День пока пустой"
              description="Добавь задачу или попроси агента разложить день по времени."
              icon={<Sparkles size={32} />}
              actions={
                <>
                  <Button label="Спланировать с агентом" variant="primary" onClick={() => navigate('agent', `Спланируй мой день на ${date}: `)} />
                  <Button label="Добавить задачу" onClick={openNew} />
                </>
              }
            />
          ) : (
            <VStack gap={4}>
              {scheduled.length > 0 && (
                <VStack>
                  <VStack gap={2}>
                    <Heading level={2}>Расписание</Heading>
                    <List hasDividers edgeCompensation="inline">
                      {scheduled.map((r, i) => [i === nowIndex ? nowLine : null, renderRow(r)])}
                      {nowIndex === scheduled.length ? nowLine : null}
                    </List>
                  </VStack>
                </VStack>
              )}
              {anytime.length > 0 && (
                <VStack>
                  <VStack gap={2}>
                    <Heading level={2}>В течение дня</Heading>
                    <List hasDividers edgeCompensation="inline">
                      {anytime.map(renderRow)}
                    </List>
                  </VStack>
                </VStack>
              )}
              <HStack gap={2} wrap="wrap">
                <Button
                  label="Спросить агента про этот день"
                  icon={<Sparkles size={16} />}
                  variant="secondary"
                  onClick={() => navigate('agent', `Посмотри мой план на ${date} и предложи, как его улучшить.`)}
                />
              </HStack>
            </VStack>
          )}
          <TaskSheet isOpen={sheetOpen} onClose={() => setSheetOpen(false)} task={editing} date={date} />
        </LayoutContent>
      }
    />
  );
}
