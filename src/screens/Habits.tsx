import {useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import {Grid} from '@astryxdesign/core/Grid';
import {Item} from '@astryxdesign/core/Item';
import {Layout, LayoutContent, LayoutHeader} from '@astryxdesign/core/Layout';
import {List} from '@astryxdesign/core/List';
import {HStack, StackItem, VStack} from '@astryxdesign/core/Stack';
import {StatusDot} from '@astryxdesign/core/StatusDot';
import {Heading, Text} from '@astryxdesign/core/Text';
import {Flame, Plus} from 'lucide-react';
import {addDays, weekdayShort} from '../../shared/dates.ts';
import {currentStreak, isChecked, isDueOn, liveHabits} from '../../shared/state.ts';
import {CHALLENGES} from '../../shared/templates.ts';
import type {AppState, Habit, ISODate, Weekday} from '../../shared/types.ts';
import {HabitSheet} from '../components/HabitSheet.tsx';
import {plural} from '../lib/format.ts';
import {useStore} from '../lib/store.tsx';

const WEEK_ORDER: Weekday[] = [1, 2, 3, 4, 5, 6, 0];

function scheduleLabel(h: Habit): string {
  const days =
    h.days.length === 7
      ? 'каждый день'
      : h.days.length === 5 && [1, 2, 3, 4, 5].every(d => h.days.includes(d as Weekday))
        ? 'по будням'
        : WEEK_ORDER.filter(d => h.days.includes(d)).map(weekdayShort).join(' ');
  return h.time ? `${days} · ${h.time}` : days;
}

/** Last seven days as dots: done, missed, or not due. */
function WeekDots({state, habit, today}: {state: AppState; habit: Habit; today: ISODate}) {
  return (
    <HStack gap={1} vAlign="center">
      {Array.from({length: 7}, (_, i) => {
        const date = addDays(today, i - 6);
        const due = isDueOn(habit, date);
        const done = isChecked(state, habit.id, date);
        const label = `${date}: ${done ? 'выполнено' : due ? 'не выполнено' : 'выходной'}`;
        return <StatusDot key={date} label={label} tooltip={label} variant={done ? 'success' : due && date < today ? 'error' : 'neutral'} />;
      })}
    </HStack>
  );
}

export function Habits() {
  const {state, today, addChallenge} = useStore();
  const [editing, setEditing] = useState<Habit | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const habits = liveHabits(state);
  const activeChallenges = new Set(habits.map(h => h.challenge).filter(Boolean));

  const open = (h: Habit | null) => {
    setEditing(h);
    setSheetOpen(true);
  };

  return (
    <Layout
      height="fill"
      padding={4}
      contentWidth={720}
      header={
        <LayoutHeader hasDivider>
          <HStack gap={2} vAlign="center">
            <StackItem size="fill">
              <Heading level={1}>Привычки</Heading>
            </StackItem>
            <Button label="Новая" icon={<Plus size={16} />} variant="primary" onClick={() => open(null)} />
          </HStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent>
          <VStack gap={6}>
            {habits.length === 0 ? (
              <EmptyState
                title="Привычек пока нет"
                description="Создай свою или начни с челленджа ниже."
                icon={<Flame size={32} />}
                actions={<Button label="Создать привычку" variant="primary" onClick={() => open(null)} />}
              />
            ) : (
              <List hasDividers edgeCompensation="inline">
                {habits.map(h => {
                  const streak = currentStreak(state, h, today);
                  return (
                    <Item
                      key={h.id}
                      as="li"
                      density="spacious"
                      descriptionLines={2}
                      onClick={() => open(h)}
                      startContent={<Text size="xl">{h.emoji}</Text>}
                      label={h.name}
                      description={`${scheduleLabel(h)}${streak > 0 ? ` · 🔥 ${streak}` : ''}`}
                      endContent={<WeekDots state={state} habit={h} today={today} />}
                    />
                  );
                })}
              </List>
            )}

            <VStack>
              <VStack gap={3}>
                <VStack gap={1}>
                  <Heading level={2}>Челленджи из TikTok</Heading>
                  <Text type="supporting">Добавляет набор привычек одним нажатием. Время и дни потом можно поменять.</Text>
                </VStack>
                <Grid columns={{minWidth: 260}} gap={3}>
                  {CHALLENGES.map(c => {
                    const added = activeChallenges.has(c.id);
                    return (
                      <Card key={c.id}>
                        <VStack gap={2} height="100%">
                          <Heading level={3}>
                            {c.emoji} {c.title}
                          </Heading>
                          <StackItem size="fill">
                            <Text type="supporting">{c.description}</Text>
                          </StackItem>
                          <Button
                            label={
                              added
                                ? 'Уже добавлен'
                                : `Добавить · ${c.habits.length} ${plural(c.habits.length, ['привычка', 'привычки', 'привычек'])}`
                            }
                            isDisabled={added}
                            onClick={() => addChallenge(c)}
                            width="100%"
                          />
                        </VStack>
                      </Card>
                    );
                  })}
                </Grid>
              </VStack>
            </VStack>
          </VStack>
          <HabitSheet isOpen={sheetOpen} onClose={() => setSheetOpen(false)} habit={editing} />
        </LayoutContent>
      }
    />
  );
}
