import {createHash, timingSafeEqual} from 'node:crypto';
import {readFile, stat} from 'node:fs/promises';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {extname, join, normalize, sep} from 'node:path';
import {clampFuture, rebaseChanges, sanitizeState} from '../shared/state.ts';
import {emptyState, type AgentResponse, type SyncResponse} from '../shared/types.ts';
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

  function authorize(req: IncomingMessage) {
    const forwarded = deps.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
    const ip = forwarded || req.socket.remoteAddress || '?';
    const now = Date.now();
    const f = fails.get(ip);
    if (f && now - f.since > FAIL_WINDOW_MS) fails.delete(ip);
    if ((fails.get(ip)?.count ?? 0) >= MAX_FAILS) {
      throw new HttpError(429, 'too many failed attempts, try again later');
    }
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || !timingSafeEqual(digest(token), expected)) {
      const cur = fails.get(ip) ?? {count: 0, since: now};
      fails.set(ip, {count: cur.count + 1, since: cur.since});
      throw new HttpError(401, 'wrong password');
    }
    fails.delete(ip);
  }

  async function api(req: IncomingMessage, res: ServerResponse, path: string) {
    if (path === '/api/health' && req.method === 'GET') {
      return send(res, 200, {ok: true, agent: deps.agent !== null});
    }
    authorize(req);

    if (path === '/api/sync' && req.method === 'POST') {
      const body = (await readJson(req)) as {since?: unknown; changes?: unknown} | null;
      const since = typeof body?.since === 'number' && body.since >= 0 ? body.since : 0;
      await deps.storage.merge(clampFuture(sanitizeState(body?.changes), Date.now()));
      const out: SyncResponse = await deps.storage.changesSince(since);
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
    let file = normalize(join(root, decodeURIComponent(path)));
    if (file !== root && !file.startsWith(root + sep)) throw new HttpError(404, 'not found');
    let info = await stat(file).catch(() => null);
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
