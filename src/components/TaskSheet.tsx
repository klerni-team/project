import {useEffect, useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {DateInput} from '@astryxdesign/core/DateInput';
import type {ISODateString} from '@astryxdesign/core/utils';
import {FormLayout} from '@astryxdesign/core/FormLayout';
import {NumberInput} from '@astryxdesign/core/NumberInput';
import {HStack} from '@astryxdesign/core/Stack';
import {TextArea} from '@astryxdesign/core/TextArea';
import {TextInput} from '@astryxdesign/core/TextInput';
import {TimeInput, type ISOTimeString} from '@astryxdesign/core/TimeInput';
import type {ISODate, Task} from '../../shared/types.ts';
import {useStore} from '../lib/store.tsx';
import {Sheet} from './Sheet.tsx';

interface Draft {
  title: string;
  date: ISODate;
  time?: string;
  durationMin?: number;
  notes: string;
}

const fromTask = (t: Task): Draft => ({
  title: t.title,
  date: t.date,
  time: t.time,
  durationMin: t.durationMin,
  notes: t.notes ?? '',
});

/** Create (task = null) or edit a task. */
export function TaskSheet({
  isOpen,
  onClose,
  task,
  date,
}: {
  isOpen: boolean;
  onClose: () => void;
  task: Task | null;
  date: ISODate;
}) {
  const {saveTask, removeTask} = useStore();
  const [draft, setDraft] = useState<Draft>({title: '', date, notes: ''});

  useEffect(() => {
    if (isOpen) setDraft(task ? fromTask(task) : {title: '', date, notes: '', durationMin: 30});
  }, [isOpen, task, date]);

  const set = (patch: Partial<Draft>) => setDraft(d => ({...d, ...patch}));
  const canSave = draft.title.trim().length > 0;

  const submit = () => {
    if (!canSave) return;
    saveTask({
      id: task?.id,
      title: draft.title.trim(),
      date: draft.date,
      done: task?.done ?? false,
      ...(draft.time ? {time: draft.time} : {}),
      ...(draft.durationMin ? {durationMin: draft.durationMin} : {}),
      ...(draft.notes.trim() ? {notes: draft.notes.trim()} : {}),
    });
    onClose();
  };

  return (
    <Sheet isOpen={isOpen} onClose={onClose} title={task ? 'Задача' : 'Новая задача'}>
      <FormLayout>
        <TextInput
          label="Что сделать"
          value={draft.title}
          onChange={title => set({title})}
          onEnter={submit}
          placeholder="Например, дописать отчёт"
          hasAutoFocus={!task}
          width="100%"
        />
        <DateInput
          label="День"
          value={draft.date as ISODateString}
          onChange={d => d && set({date: d})}
          weekStartsOn="mon"
          width="100%"
        />
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
        <TextArea label="Заметки" value={draft.notes} onChange={notes => set({notes})} isOptional rows={2} width="100%" />
        <HStack gap={2} hAlign="between">
          {task ? (
            <Button
              label="Удалить"
              variant="destructive"
              onClick={() => {
                removeTask(task.id);
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
