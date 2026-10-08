import type {AgentRequest, AgentResponse, AppState} from '../../shared/types.ts';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(path: string, password: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: {authorization: `Bearer ${password}`, 'content-type': 'application/json'},
    });
  } catch {
    throw new ApiError(0, 'Нет связи с сервером');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {error?: string} | null;
    throw new ApiError(res.status, body?.error ?? `Ошибка сервера ${res.status}`);
  }
  return (await res.json()) as T;
}

export const syncState = (password: string, state: AppState) =>
  call<AppState>('/api/state', password, {method: 'PUT', body: JSON.stringify(state)});

export const askAgent = (password: string, body: AgentRequest) =>
  call<AgentResponse>('/api/agent', password, {method: 'POST', body: JSON.stringify(body)});

export async function health(): Promise<{ok: boolean; agent: boolean} | null> {
  try {
    const res = await fetch('/api/health');
    return res.ok ? ((await res.json()) as {ok: boolean; agent: boolean}) : null;
  } catch {
    return null;
  }
}
