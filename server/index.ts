import {existsSync} from 'node:fs';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {defaultClient} from './agent.ts';
import {createHandler} from './http.ts';
import {Storage} from './storage.ts';

const password = process.env.APP_PASSWORD ?? '';
if (password.length < 8 || password.startsWith('change-me')) {
  console.error('APP_PASSWORD must be set to your own value, at least 8 characters.');
  process.exit(1);
}

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';
const dataDir = resolve(process.env.DATA_DIR ?? 'data');
const dist = resolve(process.env.STATIC_DIR ?? 'dist');
const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const handler = createHandler({
  storage: new Storage(dataDir),
  password,
  agent: hasKey ? defaultClient() : null,
  staticDir: existsSync(dist) ? dist : null,
  trustProxy: process.env.TRUST_PROXY === '1',
  log: msg => console.error(msg),
});

createServer((req, res) => void handler(req, res)).listen(port, host, () => {
  console.log(`habit-planner on http://${host}:${port} · data: ${dataDir} · agent: ${hasKey ? 'on' : 'off (no ANTHROPIC_API_KEY)'}`);
});
