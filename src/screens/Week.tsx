import {useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import {IconButton} from '@astryxdesign/core/IconButton';
import {Item} from '@astryxdesign/core/Item';
import {Layout, LayoutContent, LayoutHeader} from '@astryxdesign/core/Layout';
import {List} from '@astryxdesign/core/List';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import {HStack, StackItem, VStack} from '@astryxdesign/core/Stack';
import {Heading, Text} from '@astryxdesign/core/Text';
import {ChartColumn, ChevronLeft, ChevronRight, Sparkles} from 'lucide-react';
import type {Navigate} from '../App.tsx';
import {addDays, parseISODate, startOfWeek} from '../../shared/dates.ts';
import {completionRate, currentStreak, dayProgress, liveHabits} from '../../shared/state.ts';
import type {ISODate} from '../../shared/types.ts';
import {useStore} from '../lib/store.tsx';

const fmt = (d: ISODate, opts: Intl.DateTimeFormatOptions) => parseISODate(d).toLocaleDateString('ru-RU', opts);

export function Week({navigate}: {navigate: Navigate}) {
  const {state, today} = useStore();
  const [monday, setMonday] = useState<ISODate>(() => startOfWeek(today));
  const sunday = addDays(monday, 6);
  const isCurrent = monday === startOfWeek(today);
  // Only days that have started count toward the week's numbers.
  const lastCounted = sunday < today ? sunday : today;
  const days = Array.from({length: 7}, (_, i) => addDays(monday, i));
  const habits = liveHabits(state);
  const counted = days.filter(d => d <= lastCounted).map(d => dayProgress(state, d));
  const totals = counted.reduce((a, p) => ({done: a.done + p.done, total: a.total + p.total}), {done: 0, total: 0});

  const range = `${fmt(monday, {day: 'numeric', month: 'short'})} – ${fmt(sunday, {day: 'numeric', month: 'short'})}`;

  return (
    <Layout
      height="fill"
      padding={4}
      contentWidth={720}
      header={
        <LayoutHeader hasDivider>
          <HStack gap={2} vAlign="center">
            <IconButton label="Прошлая неделя" icon={<ChevronLeft size={18} />} variant="ghost" onClick={() => setMonday(addDays(monday, -7))} />
            <StackItem size="fill">
              <VStack gap={0.5}>
                <Heading level={1}>{isCurrent ? 'Эта неделя' : 'Неделя'}</Heading>
                <Text type="supporting">{range}</Text>
              </VStack>
            </StackItem>
            <IconButton
              label="Следующая неделя"
              icon={<ChevronRight size={18} />}
              variant="ghost"
              isDisabled={isCurrent}
              onClick={() => setMonday(addDays(monday, 7))}
            />
          </HStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent>
          {monday > today ? null : totals.total === 0 && habits.length === 0 ? (
            <EmptyState
              title="Пока нечего считать"
              description="Добавь привычки или задачи, и здесь появится статистика."
              icon={<ChartColumn size={32} />}
            />
          ) : (
            <VStack gap={6}>
              <VStack gap={2}>
                <Text type="large" weight="semibold">
                  Выполнено {totals.done} из {totals.total}
                </Text>
                <ProgressBar
                  label="Выполнено за неделю"
                  isLabelHidden
                  value={totals.done}
                  max={Math.max(totals.total, 1)}
                  variant="success"
                />
              </VStack>

              <VStack>
                <VStack gap={2}>
                  <Heading level={2}>По дням</Heading>
                  <List hasDividers edgeCompensation="inline">
                    {days.map(d => {
                      const p = dayProgress(state, d);
                      const future = d > today;
                      return (
                        <Item
                          key={d}
                          as="li"
                          label={fmt(d, {weekday: 'short', day: 'numeric', month: 'short'})}
                          description={
                            future ? (
                              'впереди'
                            ) : (
                              <ProgressBar label={`Выполнено ${d}`} isLabelHidden value={p.done} max={Math.max(p.total, 1)} />
                            )
                          }
                          endContent={<Text hasTabularNumbers type="supporting">{future ? `${p.total}` : p.total ? `${p.done}/${p.total}` : '—'}</Text>}
                        />
                      );
                    })}
                  </List>
                </VStack>
              </VStack>

              {habits.length > 0 && (
                <VStack>
                  <VStack gap={2}>
                    <Heading level={2}>Привычки</Heading>
                    <List hasDividers edgeCompensation="inline">
                      {habits.map(h => {
                        const rate = completionRate(state, h, monday, lastCounted);
                        const streak = currentStreak(state, h, today);
                        return (
                          <Item
                            key={h.id}
                            as="li"
                            startContent={<Text size="lg">{h.emoji}</Text>}
                            label={h.name}
                            description={
                              rate === null ? (
                                'на этой неделе не по плану'
                              ) : (
                                <ProgressBar label={`${h.name}: выполнение`} isLabelHidden value={Math.round(rate * 100)} variant={rate >= 0.8 ? 'success' : rate >= 0.5 ? 'accent' : 'warning'} />
                              )
                            }
                            endContent={
                              <Text hasTabularNumbers type="supporting">
                                {rate === null ? '—' : `${Math.round(rate * 100)}%`}
                                {streak > 0 ? ` · 🔥${streak}` : ''}
                              </Text>
                            }
                          />
                        );
                      })}
                    </List>
                  </VStack>
                </VStack>
              )}

              <HStack>
                <Button
                  label="Разбор недели от агента"
                  icon={<Sparkles size={16} />}
                  variant="primary"
                  onClick={() => navigate('agent', `Подведи итоги недели ${monday} – ${sunday}: что получилось, что нет и что поменять.`)}
                />
              </HStack>
            </VStack>
          )}
        </LayoutContent>
      }
    />
  );
}
