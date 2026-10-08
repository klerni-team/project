import Anthropic from '@anthropic-ai/sdk';
import {isISODate, isISOTime, weekdayOf} from '../shared/dates.ts';
import type {AgentAction, AgentRequest, AppState, ChatTurn} from '../shared/types.ts';
import {runTool, TOOL_DEFS, ToolInputError, type ToolContext} from './tools.ts';

export const MODEL = 'claude-opus-5-5';
/** Upper bound on model calls per user message, so a confused loop cannot run up cost. */
const MAX_STEPS = 10;
const MAX_HISTORY = 30;
const MAX_TURN_CHARS = 4000;

// Static, so it stays a stable cached prefix. Per-request facts (date, time)
// go in a mid-conversation system message after the latest user turn.
export const SYSTEM_PROMPT = `You are the planning assistant inside a personal habit tracker and day planner. Your user opens the app mostly on an iPhone and sometimes on a MacBook.

Your job is to turn what the user says into a concrete plan in the app, using the tools: schedule tasks on the day timeline, reschedule what slipped, set up habits, and review progress.

How to work:
- Read before you write. Call get_day for every day you plan or change, and list_habits before touching habits, so you work from real ids and do not double-book.
- Act, then report. When the request is clear, make the changes with tools instead of asking for permission. Ask one short question only when a missing detail would make the plan wrong (for example, the user names no day and it is late in the evening).
- Schedule realistically: leave gaps of at least 10–15 minutes between blocks, keep habits that already have a time slot where they are, put focused work in the morning unless the user says otherwise, and never put two blocks at the same time.
- Times are the user's local time. Today's date, weekday and current time come in a system message; never schedule today's tasks in the past.
- "Move unfinished tasks" means tasks with done = false on that day; keep their duration and give them sensible new times.
- Delete tasks or habits only when the user asks for removal.
- For reviews, look at the actual days and habits (streaks, 14-day rates) and give two or three specific observations and one suggestion. No generic motivation.

Reply format:
- Reply in the user's language; Russian unless they write in another one.
- Keep it short for a phone screen: one sentence on what you did, then the resulting plan as a short list of "HH:MM — title" lines when you scheduled something.
- Plain Markdown only (short lists, bold sparingly). No tables, no headings.`;

/** Minimal surface of the SDK the agent uses, so tests can pass a fake. */
export interface MessagesClient {
  create(
    params: Anthropic.Beta.MessageCreateParamsNonStreaming,
  ): Promise<Anthropic.Beta.BetaMessage>;
}

export function defaultClient(): MessagesClient {
  const client = new Anthropic();
  return {create: params => client.beta.messages.create(params)};
}

export class AgentInputError extends Error {}

export function parseAgentRequest(body: unknown): AgentRequest {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (!isISODate(b.today) || !isISOTime(b.now)) {
    throw new AgentInputError('today (YYYY-MM-DD) and now (HH:MM) are required');
  }
  if (!Array.isArray(b.messages) || b.messages.length === 0) {
    throw new AgentInputError('messages must be a non-empty array');
  }
  const messages: ChatTurn[] = [];
  for (const m of b.messages.slice(-MAX_HISTORY)) {
    const role = (m as ChatTurn)?.role;
    const content = (m as ChatTurn)?.content;
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string' || !content.trim()) {
      throw new AgentInputError('each message needs role user|assistant and text content');
    }
    messages.push({role, content: content.slice(0, MAX_TURN_CHARS)});
  }
  // The API requires the conversation to start with the user and the
  // request to end on the user's new message.
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (messages.at(-1)?.role !== 'user') {
    throw new AgentInputError('the last message must be from the user');
  }
  if (typeof b.requestId !== 'string' || !/^[\w-]{8,64}$/.test(b.requestId)) {
    throw new AgentInputError('requestId must be 8–64 letters, digits, - or _');
  }
  return {requestId: b.requestId, messages, today: b.today, now: b.now};
}

const WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface AgentResult {
  reply: string;
  actions: AgentAction[];
  state: AppState;
  /** True when at least one tool changed the state. */
  changed: boolean;
}

export async function runAgent(
  client: MessagesClient,
  req: AgentRequest,
  state: AppState,
  now: () => number = Date.now,
): Promise<AgentResult> {
  const ctx: ToolContext = {state, today: req.today, now};
  const actions: AgentAction[] = [];
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...req.messages.map(m => ({role: m.role, content: m.content})),
    {
      role: 'system',
      content: `Today is ${WEEKDAYS_EN[weekdayOf(req.today)]}, ${req.today}. Current local time: ${req.now}.`,
    },
  ];
  const textParts: string[] = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await client.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: {effort: 'medium'},
      cache_control: {type: 'ephemeral'},
      system: SYSTEM_PROMPT,
      tools: TOOL_DEFS,
      messages,
    });

    if (response.stop_reason === 'refusal') {
      return {
        reply: 'Не могу помочь с этим запросом. Попробуй сформулировать по-другому.',
        actions,
        state: ctx.state,
        changed: actions.length > 0,
      };
    }

    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) textParts.push(block.text.trim());
    }
    messages.push({role: 'assistant', content: response.content});

    if (response.stop_reason !== 'tool_use') break;

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      try {
        const out = runTool(ctx, block.name, block.input);
        const mutates = !['get_day', 'list_habits'].includes(block.name);
        if (mutates) actions.push({tool: block.name, summary: out.summary});
        results.push({type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out.result)});
      } catch (err) {
        if (!(err instanceof ToolInputError)) throw err;
        results.push({type: 'tool_result', tool_use_id: block.id, content: err.message, is_error: true});
      }
    }
    // All results for one assistant turn go back in a single user message.
    messages.push({role: 'user', content: results});

    if (step === MAX_STEPS - 1) {
      textParts.push('Остановился: слишком много шагов для одного запроса. Проверь план и уточни, что доделать.');
    }
  }

  // Intermediate narration before tool calls is noise on a phone; the last
  // text block is the summary the prompt asks for.
  const reply = textParts.at(-1) ?? 'Готово.';
  return {reply, actions, state: ctx.state, changed: actions.length > 0};
}
