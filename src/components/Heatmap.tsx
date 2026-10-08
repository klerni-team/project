import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Tooltip} from '@astryxdesign/core/Tooltip';
import {addDays, startOfWeek} from '../../shared/dates.ts';
import {isChecked, isDueOn} from '../../shared/state.ts';
import type {AppState, Habit, ISODate} from '../../shared/types.ts';

const CELL = 14;

const COLOR = {
  done: 'var(--color-success)',
  missed: 'var(--color-border-emphasized)',
  off: 'var(--color-background-muted)',
  future: 'transparent',
} as const;

/** GitHub-style grid: one column per week (Mon at top), newest on the right. */
export function Heatmap({state, habit, today, weeks = 12}: {state: AppState; habit: Habit; today: ISODate; weeks?: number}) {
  const firstMonday = addDays(startOfWeek(today), -7 * (weeks - 1));
  return (
    <HStack gap={0.5} role="img" aria-label={`История привычки ${habit.name} за ${weeks} недель`}>
      {Array.from({length: weeks}, (_, w) => (
        <VStack key={w} gap={0.5}>
          {Array.from({length: 7}, (_, d) => {
            const date = addDays(firstMonday, w * 7 + d);
            const kind =
              date > today ? 'future' : !isDueOn(habit, date) ? 'off' : isChecked(state, habit.id, date) ? 'done' : 'missed';
            return (
              <Tooltip key={date} content={date} isEnabled={kind !== 'future'}>
                <VStack
                  as="span"
                  width={CELL}
                  height={CELL}
                  style={{background: COLOR[kind], borderRadius: 'var(--radius-inner)'}}
                />
              </Tooltip>
            );
          })}
        </VStack>
      ))}
    </HStack>
  );
}
