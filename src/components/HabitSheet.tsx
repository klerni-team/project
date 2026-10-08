import {useEffect, useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {FormLayout} from '@astryxdesign/core/FormLayout';
import {NumberInput} from '@astryxdesign/core/NumberInput';
import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {TimeInput, type ISOTimeString} from '@astryxdesign/core/TimeInput';
import {ToggleButton} from '@astryxdesign/core/ToggleButton';
import {weekdayShort} from '../../shared/dates.ts';
import {currentStreak} from '../../shared/state.ts';
import {EVERY_DAY} from '../../shared/templates.ts';
import type {Habit, Weekday} from '../../shared/types.ts';
import {useStore} from '../lib/store.tsx';
import {Heatmap} from './Heatmap.tsx';
import {Sheet} from './Sheet.tsx';

const WEEK_ORDER: Weekday[] = [1, 2, 3, 4, 5, 6, 0];

interface Draft {
  name: string;
  emoji: string;
  days: Weekday[];
  time?: string;
  durationMin?: number;
}

/** Create (habit = null) or edit a habit; edit mode also shows its history. */
export function HabitSheet({isOpen, onClose, habit}: {isOpen: boolean; onClose: () => void; habit: Habit | null}) {
  const {state, today, saveHabit, removeHabit} = useStore();
  const [draft, setDraft] = useState<Draft>({name: '', emoji: '✅', days: EVERY_DAY});

  useEffect(() => {
    if (!isOpen) return;
    setDraft(
      habit
        ? {name: habit.name, emoji: habit.emoji, days: habit.days, time: habit.time, durationMin: habit.durationMin}
        : {name: '', emoji: '✅', days: EVERY_DAY},
    );
  }, [isOpen, habit]);

  const set = (patch: Partial<Draft>) => setDraft(d => ({...d, ...patch}));
  const toggleDay = (d: Weekday) =>
    set({days: draft.days.includes(d) ? draft.days.filter(x => x !== d) : [...draft.days, d].sort()});
  const canSave = draft.name.trim().length > 0 && draft.days.length > 0;

  const submit = () => {
    if (!canSave) return;
    saveHabit({
      id: habit?.id,
      name: draft.name.trim(),
      emoji: draft.emoji.trim() || '✅',
      days: draft.days,
      ...(draft.time ? {time: draft.time} : {}),
      ...(draft.durationMin ? {durationMin: draft.durationMin} : {}),
      ...(habit?.challenge ? {challenge: habit.challenge} : {}),
    });
    onClose();
  };

  return (
    <Sheet isOpen={isOpen} onClose={onClose} title={habit ? `${habit.emoji} ${habit.name}` : 'Новая привычка'}>
      <FormLayout>
        {habit && (
          <VStack gap={2}>
            <Text type="supporting">Серия: {currentStreak(state, habit, today)} дн. · последние 12 недель</Text>
            <Heatmap state={state} habit={habit} today={today} />
          </VStack>
        )}
        <HStack gap={3}>
          <TextInput label="Эмодзи" value={draft.emoji} onChange={emoji => set({emoji: emoji.slice(0, 8)})} width={88} />
          <TextInput
            label="Привычка"
            value={draft.name}
            onChange={name => set({name})}
            onEnter={submit}
            placeholder="Например, 10 000 шагов"
            hasAutoFocus={!habit}
            width="100%"
          />
        </HStack>
        <VStack gap={1}>
          <Text type="label">Дни</Text>
          <HStack gap={1} wrap="wrap">
            {WEEK_ORDER.map(d => (
              <ToggleButton
                key={d}
                label={weekdayShort(d)}
                isPressed={draft.days.includes(d)}
                onPressedChange={() => toggleDay(d)}
                size="sm"
              />
            ))}
          </HStack>
        </VStack>
        <HStack gap={3}>
          <TimeInput
            label="Время"
            value={draft.time as ISOTimeString | undefined}
            onChange={time => set({time})}
            hourFormat="24h"
            hasClear
            isOptional
            width="100%"
          />
          <NumberInput
            label="Минут"
            value={draft.durationMin ?? null}
            onChange={v => set({durationMin: v || undefined})}
            min={5}
            max={720}
            step={5}
            isIntegerOnly
            hasClear
            width="100%"
          />
        </HStack>
        <HStack gap={2} hAlign="between">
          {habit ? (
            <Button
              label="Удалить"
              variant="destructive"
              onClick={() => {
                removeHabit(habit.id);
                onClose();
              }}
            />
          ) : (
            <Button label="Отмена" variant="ghost" onClick={onClose} />
          )}
          <Button label="Сохранить" variant="primary" onClick={submit} isDisabled={!canSave} />
        </HStack>
      </FormLayout>
    </Sheet>
  );
}
