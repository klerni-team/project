import type {AgentRequest, AgentResponse, SyncRequest, SyncResponse} from '../../shared/types.ts';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(path: string, password: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: {authorization: `Bearer ${password}`, 'content-type': 'application/json'},
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Нет связи с сервером');
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as {error?: string} | null;
    const message =
      res.status === 401
        ? 'Неверный пароль сервера'
        : res.status === 429
          ? 'Слишком много неверных паролей, подожди 10 минут'
          : (data?.error ?? `Ошибка сервера ${res.status}`);
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

export const syncState = (password: string, body: SyncRequest) =>
  call<SyncResponse>('/api/sync', password, body);

export const askAgent = (password: string, body: AgentRequest) =>
  call<AgentResponse>('/api/agent', password, body);

export async function health(): Promise<{ok: boolean; agent: boolean} | null> {
  try {
    const res = await fetch('/api/health');
    return res.ok ? ((await res.json()) as {ok: boolean; agent: boolean}) : null;
  } catch {
    return null;
  }
}
