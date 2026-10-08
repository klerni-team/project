import type Anthropic from '@anthropic-ai/sdk';
import {mkdtemp, rm} from 'node:fs/promises';
import {createServer, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {upsertTask} from '../shared/state.ts';
import {emptyState, type AgentResponse, type AppState, type SyncResponse, type Task} from '../shared/types.ts';
import {parseAgentRequest, runAgent, type MessagesClient} from './agent.ts';
import {createHandler} from './http.ts';
import {Storage} from './storage.ts';
import {runTool, ToolInputError, type ToolContext} from './tools.ts';

type Block = Anthropic.Beta.BetaContentBlock;

const msg = (content: Block[], stop: Anthropic.Beta.BetaMessage['stop_reason']): Anthropic.Beta.BetaMessage =>
  ({id: 'm', type: 'message', role: 'assistant', model: 'x', content, stop_reason: stop, stop_sequence: null, usage: {}}) as unknown as Anthropic.Beta.BetaMessage;
const text = (t: string) => ({type: 'text', text: t, citations: null}) as unknown as Block;
const toolUse = (id: string, name: string, input: unknown) => ({type: 'tool_use', id, name, input}) as unknown as Block;

/** Plays back scripted responses and records each request. */
function fakeClient(script: Anthropic.Beta.BetaMessage[]) {
  const calls: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
  const client: MessagesClient = {
    async create(params) {
      calls.push(structuredClone(params));
      const next = script.shift();
      if (!next) throw new Error('script exhausted');
      return next;
    },
  };
  return {client, calls};
}

const task = (over: Partial<Task> = {}): Task => ({
  id: 't1', title: 'Отчёт', date: '2026-10-08', time: '10:00', durationMin: 60, done: false, updatedAt: 1, ...over,
});

const req = (content = 'Спланируй день', requestId = 'req-00000001') => ({
  requestId,
  messages: [{role: 'user' as const, content}],
  today: '2026-10-08',
  now: '09:00',
});

describe('tools', () => {
  const ctx = (state: AppState = emptyState()): ToolContext => ({state, today: '2026-10-08', now: () => 100});

  it('adds and reschedules a task', () => {
    const c = ctx();
    const added = runTool(c, 'add_task', {title: 'Зал', date: '2026-10-08', time: '18:00', duration_min: 60});
    const id = (added.result as {id: string}).id;
    expect(c.state.tasks[id]).toMatchObject({title: 'Зал', time: '18:00', durationMin: 60, done: false});
    const moved = runTool(c, 'update_task', {id, date: '2026-10-09', time: ''});
    expect(c.state.tasks[id].date).toBe('2026-10-09');
    expect(c.state.tasks[id].time).toBeUndefined();
    expect(moved.summary).toContain('Перенёс');
  });

  it('rejects bad input with a ToolInputError the model can read', () => {
    const c = ctx();
    expect(() => runTool(c, 'add_task', {title: 'x', date: '2026-02-30'})).toThrow(ToolInputError);
    expect(() => runTool(c, 'add_task', {title: 'x', date: '2026-10-08', time: '25:00'})).toThrow(ToolInputError);
    expect(() => runTool(c, 'update_task', {id: 'missing'})).toThrow(/no task/);
    expect(() => runTool(c, 'constructor', {})).toThrow(/unknown tool/);
    expect(() => runTool(c, 'add_habit', {name: 'x', days: []})).toThrow(ToolInputError);
  });

  it('get_day hides deleted tasks', () => {
    let s = upsertTask(emptyState(), task());
    s = upsertTask(s, task({id: 't2', deleted: true}));
    const out = runTool(ctx(s), 'get_day', {date: '2026-10-08'}).result as {tasks: {id: string}[]};
    expect(out.tasks.map(t => t.id)).toEqual(['t1']);
  });
});

describe('parseAgentRequest', () => {
  it('requires a trailing user message and valid clock', () => {
    expect(() => parseAgentRequest({messages: [{role: 'assistant', content: 'hi'}], today: '2026-10-08', now: '09:00'})).toThrow();
    expect(() => parseAgentRequest({...req(), now: '9am'})).toThrow();
    expect(() => parseAgentRequest({...req(), messages: [{role: 'system', content: 'x'}]})).toThrow();
  });
  it('requires a well-formed requestId', () => {
    expect(() => parseAgentRequest({...req(), requestId: undefined})).toThrow(/requestId/);
    expect(() => parseAgentRequest({...req(), requestId: 'bad id!'})).toThrow(/requestId/);
  });
  it('drops leading assistant turns', () => {
    const r = parseAgentRequest({...req(), messages: [{role: 'assistant', content: 'Привет'}, {role: 'user', content: 'План'}]});
    expect(r.messages).toEqual([{role: 'user', content: 'План'}]);
  });
});

describe('runAgent', () => {
  it('runs tools, returns tool results in one user message and the final text', async () => {
    const {client, calls} = fakeClient([
      msg([text('Смотрю день'), toolUse('a', 'get_day', {date: '2026-10-08'}), toolUse('b', 'add_task', {title: 'Зал', date: '2026-10-08', time: '18:00'})], 'tool_use'),
      msg([text('Готово: 18:00 — Зал')], 'end_turn'),
    ]);
    const out = await runAgent(client, req(), emptyState(), () => 5);

    expect(out.reply).toBe('Готово: 18:00 — Зал');
    expect(out.changed).toBe(true);
    expect(out.actions.map(a => a.tool)).toEqual(['add_task']);
    expect(Object.values(out.state.tasks)[0]).toMatchObject({title: 'Зал', updatedAt: 5});

    const first = calls[0];
    expect(first.model).toBe('claude-opus-5-5');
    expect(first.fallbacks).toBe('default');
    expect(first.messages.at(-1)).toMatchObject({role: 'system'});
    expect(String(first.messages.at(-1)?.content)).toContain('2026-10-08');

    const second = calls[1].messages;
    const results = second.at(-1)?.content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(second.at(-1)?.role).toBe('user');
    expect(results.map(r => r.tool_use_id)).toEqual(['a', 'b']);
  });

  it('feeds tool errors back with is_error instead of throwing', async () => {
    const {client, calls} = fakeClient([
      msg([toolUse('a', 'update_task', {id: 'nope', done: true})], 'tool_use'),
      msg([text('Не нашёл задачу')], 'end_turn'),
    ]);
    const out = await runAgent(client, req(), emptyState());
    const results = calls[1].messages.at(-1)?.content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(results[0].is_error).toBe(true);
    expect(out.changed).toBe(false);
  });

  it('handles a refusal without reading content', async () => {
    const {client} = fakeClient([msg([], 'refusal')]);
    const out = await runAgent(client, req(), emptyState());
    expect(out.reply).toMatch(/Не могу/);
    expect(out.changed).toBe(false);
  });

  it('stops after the step limit', async () => {
    const loop = () => msg([toolUse('x', 'list_habits', {})], 'tool_use');
    const {client, calls} = fakeClient(Array.from({length: 20}, loop));
    const out = await runAgent(client, req(), emptyState());
    expect(calls).toHaveLength(10);
    expect(out.reply).toMatch(/Остановился/);
  });
});

describe('http', () => {
  let dir: string;
  let server: Server | null = null;
  let base: string;
  let storage: Storage;

  async function start(agent: MessagesClient | null) {
    if (server) await new Promise(r => server!.close(r));
    storage = new Storage(dir);
    server = createServer(createHandler({storage, password: 'secret-pass', agent, staticDir: null}));
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const auth = {authorization: 'Bearer secret-pass', 'content-type': 'application/json'};
  const sync = async (since: number, changes: AppState) =>
    (await (await fetch(`${base}/api/sync`, {method: 'POST', headers: auth, body: JSON.stringify({since, changes})})).json()) as SyncResponse;
  const ask = (body: unknown) => fetch(`${base}/api/agent`, {method: 'POST', headers: auth, body: JSON.stringify(body)});

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'habits-'));
  });
  afterEach(async () => {
    if (server) await new Promise(r => server!.close(r));
    server = null;
    await rm(dir, {recursive: true, force: true});
  });

  it('rejects requests without the password', async () => {
    await start(null);
    expect((await fetch(`${base}/api/sync`, {method: 'POST', body: '{}'})).status).toBe(401);
    expect((await fetch(`${base}/api/sync`, {method: 'POST', headers: {authorization: 'Bearer nope'}, body: '{}'})).status).toBe(401);
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });

  it('syncs deltas by revision and persists to disk', async () => {
    await start(null);
    const first = await sync(0, upsertTask(emptyState(), task()));
    expect(Object.keys(first.changes.tasks)).toEqual(['t1']);
    // Nothing new since the returned cursor.
    const idle = await sync(first.rev, emptyState());
    expect(idle.changes).toEqual(emptyState());
    expect(idle.rev).toBe(first.rev);
    // An older copy from another device loses and produces no change.
    const stale = await sync(first.rev, upsertTask(emptyState(), task({title: 'старое', updatedAt: 0})));
    expect(stale.changes.tasks).toEqual({});
    expect((await new Storage(dir).read()).tasks.t1.title).toBe('Отчёт');
    // A device that has never synced gets everything.
    expect(Object.keys((await sync(0, emptyState())).changes.tasks)).toEqual(['t1']);
  });

  it('clamps future timestamps on sync', async () => {
    await start(null);
    await sync(0, upsertTask(emptyState(), task({updatedAt: 1e308})));
    expect((await storage.read()).tasks.t1.updatedAt).toBeLessThan(Date.now() + 1000);
  });

  it('returns 503 for the agent without a key and 400 for bad bodies', async () => {
    await start(null);
    expect((await ask(req())).status).toBe(503);
    await start(fakeClient([]).client);
    expect((await ask({messages: []})).status).toBe(400);
    expect((await fetch(`${base}/api/agent`, {method: 'POST', headers: auth, body: 'not json'})).status).toBe(400);
  });

  it('answers a retried request id once, without a second model run', async () => {
    const {client, calls} = fakeClient([
      msg([toolUse('a', 'add_task', {title: 'Зал', date: '2026-10-08'})], 'tool_use'),
      msg([text('Добавил')], 'end_turn'),
    ]);
    await start(client);
    const a = (await (await ask(req())).json()) as AgentResponse;
    const b = (await (await ask(req())).json()) as AgentResponse;
    expect(a.reply).toBe('Добавил');
    expect(b).toEqual(a);
    expect(calls).toHaveLength(2);
    expect(Object.values((await storage.read()).tasks)).toHaveLength(1);
  });

  it('keeps a user edit made while the agent was running', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const script = [
      msg([toolUse('a', 'update_task', {id: 't1', date: '2026-10-09'})], 'tool_use'),
      msg([text('Перенёс')], 'end_turn'),
    ];
    const client: MessagesClient = {
      async create() {
        await gate;
        return script.shift()!;
      },
    };
    await start(client);
    await sync(0, upsertTask(emptyState(), task({updatedAt: 1})));
    const pending = ask(req('Перенеси на завтра'));
    // The user ticks the task while the model is thinking.
    await new Promise(r => setTimeout(r, 50));
    await sync(0, upsertTask(emptyState(), task({done: true, updatedAt: 2})));
    release();
    const body = (await (await pending).json()) as AgentResponse;
    expect(body.changes.tasks.t1).toMatchObject({date: '2026-10-09', done: true});
    expect((await storage.read()).tasks.t1).toMatchObject({date: '2026-10-09', done: true});
  });
});
