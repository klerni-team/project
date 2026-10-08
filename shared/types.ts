// Data model shared by the client, the sync server and the AI agent.
// Every record carries `updatedAt` (ms) so devices can merge last-write-wins
// per record; deletions are tombstones (`deleted: true`) so they sync too.

/** Calendar date in the user's local time zone, `YYYY-MM-DD`. */
export type ISODate = string;
/** Local wall-clock time, `HH:MM` (24h). */
export type ISOTime = string;
/** 0 = Sunday … 6 = Saturday, matching `Date#getDay()`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface BaseRecord {
  id: string;
  updatedAt: number;
  deleted?: boolean;
}

export interface Habit extends BaseRecord {
  name: string;
  emoji: string;
  /** Days of the week the habit is due. */
  days: Weekday[];
  /** Optional slot on the day timeline. */
  time?: ISOTime;
  durationMin?: number;
  /** Template id when the habit came from a challenge (e.g. `75-hard`). */
  challenge?: string;
  /** First local date the habit is due; earlier days never count as missed. */
  startDate: ISODate;
  createdAt: number;
}

export interface Task extends BaseRecord {
  title: string;
  date: ISODate;
  time?: ISOTime;
  durationMin?: number;
  done: boolean;
  notes?: string;
}

/** One habit on one day. id is `${habitId}:${date}`. */
export interface HabitCheck extends BaseRecord {
  habitId: string;
  date: ISODate;
  done: boolean;
}

export interface AppState {
  habits: Record<string, Habit>;
  tasks: Record<string, Task>;
  checks: Record<string, HabitCheck>;
}

export const emptyState = (): AppState => ({habits: {}, tasks: {}, checks: {}});

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Body of `POST /api/sync`: local edits since the last push, and the server cursor. */
export interface SyncRequest {
  since: number;
  changes: AppState;
}

/** Records the server changed after `since`, and the new cursor. */
export interface SyncResponse {
  rev: number;
  changes: AppState;
}

/** Body of `POST /api/agent`. */
export interface AgentRequest {
  /** Client-generated; a retried request with the same id is answered once. */
  requestId: string;
  messages: ChatTurn[];
  /** The client's local date and time, so the agent plans in the user's zone. */
  today: ISODate;
  now: ISOTime;
}

export interface AgentAction {
  tool: string;
  summary: string;
}

/** Response of `POST /api/agent`. `changes` holds the records the agent wrote. */
export interface AgentResponse {
  reply: string;
  actions: AgentAction[];
  changes: AppState;
}
