import type { Snapshot } from './types';

let session: Promise<string> | undefined;
export const embedded = /^\/_magpie\/[a-f0-9]{64}\//.test(location.pathname);
const base = embedded ? location.pathname.match(/^\/_magpie\/[a-f0-9]{64}\//)![0] : '/';

function token() {
  session ??= fetch(`${base}api/session`, { cache: 'no-store', credentials: 'same-origin' }).then(async response => {
    if (!response.ok) throw new Error('无法连接本地服务，请确认插件已启动。');
    const body = await response.json() as { token: string };
    return body.token;
  }).catch(error => { session = undefined; throw error; });
  return session;
}

export async function request<T>(path: string, method = 'GET', body?: unknown, retrySession = true, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const sessionToken = await token();
  signal?.throwIfAborted();
  const response = await fetch(`${base}api${path}`, {
    method, cache: 'no-store', credentials: 'same-origin', signal,
    headers: { 'X-Shelf-Token': sessionToken, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { error?: string } | null;
    if (response.status === 403 && error?.error?.includes('session expired') && retrySession) {
      session = undefined;
      return request<T>(path, method, body, false, signal);
    }
    throw new Error(error?.error || `请求失败 (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export const mutate = (path: string, method: string, body?: unknown) => request<Snapshot>(path, method, body ?? (method === 'POST' ? {} : undefined));

export async function exportPack(id: string, name: string) {
  if (embedded) {
    await request('/exports', 'POST', { type: 'pack', id });
    return;
  }
  const packDocument = await request<unknown>(`/packs/${encodeURIComponent(id)}/export`);
  const url = URL.createObjectURL(new Blob([JSON.stringify(packDocument, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name.replace(/[\\/:*?"<>|]/g, '-')}.skill-shelf-pack.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
