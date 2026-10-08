import {createHash, timingSafeEqual} from 'node:crypto';
import {readFile, stat} from 'node:fs/promises';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {extname, join, normalize, sep} from 'node:path';
import {clampFuture, rebaseChanges, sanitizeState, TABLES} from '../shared/state.ts';
import {emptyState, type AgentResponse, type BaseRecord, type SyncResponse} from '../shared/types.ts';
import {AgentInputError, parseAgentRequest, runAgent, type MessagesClient} from './agent.ts';
import type {Storage} from './storage.ts';

export interface AppDeps {
  storage: Storage;
  password: string;
  /** null when ANTHROPIC_API_KEY is not configured: the agent endpoint returns 503. */
  agent: MessagesClient | null;
  /** Built client (`dist/`); null in dev, where Vite serves it. */
  staticDir: string | null;
  /** Read the client IP from X-Forwarded-For (set when behind Caddy/nginx). */
  trustProxy?: boolean;
  log?: (msg: string) => void;
}

const MAX_BODY = 8 * 1024 * 1024;
/** How long a finished agent answer is kept for a retried request id. */
const AGENT_REPLAY_MS = 15 * 60 * 1000;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILS = 20;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * Lockout bucket for an address. One IPv6 host usually owns a whole /64,
 * so rotating within it must not reset the counter.
 */
export function lockoutKey(ip: string): string {
  const v4 = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4) return v4[1];
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const full = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return full.slice(0, 4).map(h => h.toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'});
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

export function createHandler(deps: AppDeps) {
  const expected = digest(deps.password);
  const fails = new Map<string, {count: number; since: number}>();
  const agentRuns = new Map<string, {at: number; result: Promise<AgentResponse>}>();
  const log = deps.log ?? (() => {});

  /**
   * Runs the agent on a snapshot (a long model call must not block sync),
   * then re-applies its field edits on top of whatever the user changed
   * meanwhile. A retried request id gets the first run's answer instead of
   * a second, duplicate run.
   */
  function runAgentOnce(parsed: ReturnType<typeof parseAgentRequest>, agent: MessagesClient): Promise<AgentResponse> {
    const now = Date.now();
    for (const [id, run] of agentRuns) if (now - run.at > AGENT_REPLAY_MS) agentRuns.delete(id);
    const existing = agentRuns.get(parsed.requestId);
    if (existing) return existing.result;
    const result = (async (): Promise<AgentResponse> => {
      const before = await deps.storage.read();
      const out = await runAgent(agent, parsed, before);
      const changes = out.changed
        ? await deps.storage.update(cur => rebaseChanges(cur, before, out.state, Date.now()))
        : emptyState();
      return {reply: out.reply, actions: out.actions, changes};
    })();
    agentRuns.set(parsed.requestId, {at: now, result});
    // A failed run may be retried for real.
    result.catch(() => agentRuns.delete(parsed.requestId));
    return result;
  }

  let lastPrune = 0;

  function authorize(req: IncomingMessage) {
    // The proxy appends the address it saw, so the rightmost entry is the
    // one a client cannot forge (nginx keeps client-sent entries on the left).
    const forwarded = deps.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',').at(-1)!.trim() : '';
    const key = lockoutKey(forwarded || req.socket.remoteAddress || '?');
    const now = Date.now();
    if (now - lastPrune > 60_000) {
      lastPrune = now;
      for (const [k, f] of fails) if (now - f.since > FAIL_WINDOW_MS) fails.delete(k);
    }
    const f = fails.get(key);
    if (f && now - f.since > FAIL_WINDOW_MS) fails.delete(key);
    if ((fails.get(key)?.count ?? 0) >= MAX_FAILS) {
      throw new HttpError(429, 'too many failed attempts, try again later');
    }
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || !timingSafeEqual(digest(token), expected)) {
      const cur = fails.get(key) ?? {count: 0, since: now};
      fails.set(key, {count: cur.count + 1, since: cur.since});
      throw new HttpError(401, 'wrong password');
    }
    fails.delete(key);
  }

  async function api(req: IncomingMessage, res: ServerResponse, path: string) {
    if (path === '/api/health' && req.method === 'GET') {
      return send(res, 200, {ok: true, agent: deps.agent !== null});
    }
    authorize(req);

    if (path === '/api/sync' && req.method === 'POST') {
      const body = (await readJson(req)) as {since?: unknown; changes?: unknown} | null;
      const since = typeof body?.since === 'number' && body.since >= 0 ? body.since : 0;
      const sent = sanitizeState(body?.changes);
      await deps.storage.merge(clampFuture(sent, Date.now()));
      const {epoch, rev, changes} = await deps.storage.changesSince(since);
      // Pushed records the server did not keep as sent (an older stamp lost
      // to a newer copy, or a future stamp was clamped): the device must
      // adopt the server's copy or it would keep showing its own forever.
      const current = await deps.storage.read();
      const corrected = emptyState();
      for (const t of TABLES) {
        for (const [id, rec] of Object.entries(sent[t] as Record<string, BaseRecord>)) {
          const kept = (current[t] as Record<string, BaseRecord>)[id];
          if (kept && JSON.stringify(kept) !== JSON.stringify(rec)) {
            (corrected[t] as Record<string, BaseRecord>)[id] = kept;
          }
        }
      }
      const out: SyncResponse = {epoch, rev, changes, corrected};
      return send(res, 200, out);
    }

    if (path === '/api/agent' && req.method === 'POST') {
      if (!deps.agent) throw new HttpError(503, 'agent is not configured: set ANTHROPIC_API_KEY on the server');
      let parsed;
      try {
        parsed = parseAgentRequest(await readJson(req));
      } catch (err) {
        if (err instanceof AgentInputError) throw new HttpError(400, err.message);
        throw err;
      }
      return send(res, 200, await runAgentOnce(parsed, deps.agent));
    }

    throw new HttpError(404, 'not found');
  }

  async function serveStatic(res: ServerResponse, path: string, method: string) {
    if (!deps.staticDir || (method !== 'GET' && method !== 'HEAD')) throw new HttpError(404, 'not found');
    const root = deps.staticDir;
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      throw new HttpError(404, 'not found');
    }
    let file = normalize(join(root, decoded));
    if (file !== root && !file.startsWith(root + sep)) throw new HttpError(404, 'not found');
    let info = await stat(file).catch(() => null);
    // A missing hashed asset must 404: an HTML fallback served as a JS chunk
    // would be cached by the service worker.
    if (!info && path.startsWith('/assets/')) throw new HttpError(404, 'not found');
    if (!info || info.isDirectory()) {
      // SPA fallback: unknown paths get the app shell.
      file = join(root, 'index.html');
      info = await stat(file).catch(() => null);
      if (!info) throw new HttpError(404, 'not found');
    }
    const ext = extname(file);
    const immutable = file.startsWith(join(root, 'assets') + sep);
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(method === 'HEAD' ? undefined : await readFile(file));
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://local');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    try {
      if (url.pathname.startsWith('/api/')) await api(req, res, url.pathname);
      else await serveStatic(res, url.pathname, req.method ?? 'GET');
    } catch (err) {
      if (err instanceof HttpError) {
        if (!res.headersSent) send(res, err.status, {error: err.message});
        return;
      }
      log(`error ${req.method} ${url.pathname}: ${(err as Error).stack ?? err}`);
      if (!res.headersSent) send(res, 500, {error: 'internal error'});
      else res.end();
    }
  };
}
