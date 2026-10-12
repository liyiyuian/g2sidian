// Client for g2sidian_api.py (the JSON control-plane over the user's Obsidian vaults).
// Connection comes from per-user config (localStorage), NOT build-time secrets.
import { getConfig, getOpenaiKeyPath } from './config'

const base = () => getConfig().base
const authHeaders = (): Record<string, string> => {
  const t = getConfig().token
  return t ? { Authorization: `Bearer ${t}` } : {}
}
const jsonHeaders = (): Record<string, string> => ({ ...authHeaders(), 'content-type': 'application/json' })
// optional backend key-file path (set on the phone Setup) — appended to the voice endpoints
const keyPathQ = () => { const p = getOpenaiKeyPath(); return p ? `?keypath=${encodeURIComponent(p)}` : '' }

// Every request is time-bounded — a Tailscale peer that went to sleep must FAIL (with a status the
// UI can explain + retry), not hang a spinner forever. 9s covers a cold search on a big vault.
const TIMEOUT_MS = 9000
export class ApiError extends Error {
  status: number
  constructor(name: string, status: number) { super(`${name} ${status}`); this.status = status }
}
async function req(path: string, init: RequestInit = {}): Promise<Response> {
  const b = base()
  if (!b) throw new ApiError('not configured', 0) // no backend URL yet -> definite, explainable failure
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    return await fetch(`${b}${path}`, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

// mtime is the write compare-and-swap token — a STRING (nanoseconds overflow JS number precision).
export interface Entry { name: string; type: 'dir' | 'note'; file?: string; mtime: number; size?: number }
export interface ListResult { vault: string; path: string; parent: string; entries: Entry[] }
export interface Link { label: string; path: string | null } // path null = unresolved wikilink
export interface Note { vault: string; path: string; title: string; tags: string[]; aliases: string[]; lines: string[]; links: Link[]; mtime: string; size: number }
export interface SearchResult { path: string; title: string; score: number; snippet: string; mtime: number }
export interface RecentItem { path: string; title: string; mtime: number } // mtime = epoch seconds
export interface Bookmark { path: string; title: string }
export interface DueTask { path: string; desc: string; due: string; overdue: boolean }
export interface CaptureTarget { vault: string; path: string; exists: boolean; label: string; mode: string }

export async function health(): Promise<{ ok: boolean; voice: boolean; vaults: string[]; checked?: string[] }> {
  const r = await req(`/api/health${keyPathQ()}`, { headers: authHeaders() })
  if (!r.ok) throw new ApiError('health', r.status)
  return r.json()
}

export async function listVaults(): Promise<string[]> {
  const r = await req(`/api/vaults`, { headers: authHeaders() })
  if (!r.ok) throw new ApiError('vaults', r.status)
  return (await r.json()).vaults.map((v: { name: string }) => v.name)
}

export async function listDir(vault: string, path: string): Promise<ListResult> {
  const r = await req(`/api/list?vault=${encodeURIComponent(vault)}&path=${encodeURIComponent(path)}`, { headers: authHeaders() })
  if (!r.ok) throw new ApiError('list', r.status)
  return r.json()
}

export async function getNote(vault: string, path: string): Promise<Note> {
  const r = await req(`/api/note?vault=${encodeURIComponent(vault)}&path=${encodeURIComponent(path)}`, { headers: authHeaders() })
  if (!r.ok) throw new ApiError('note', r.status)
  return r.json()
}

export async function search(vault: string, q: string, scope = ''): Promise<SearchResult[]> {
  const sc = scope ? `&scope=${encodeURIComponent(scope)}` : ''
  const r = await req(`/api/search?vault=${encodeURIComponent(vault)}&q=${encodeURIComponent(q)}${sc}`, { headers: authHeaders() })
  if (!r.ok) throw new ApiError('search', r.status)
  return (await r.json()).results
}

export async function recent(vault: string): Promise<RecentItem[]> {
  const r = await req(`/api/recent?vault=${encodeURIComponent(vault)}`, { headers: authHeaders() })
  if (!r.ok) throw new ApiError('recent', r.status)
  return (await r.json()).results
}

export async function bookmarks(vault: string): Promise<Bookmark[]> {
  const r = await req(`/api/bookmarks?vault=${encodeURIComponent(vault)}`, { headers: authHeaders() })
  if (!r.ok) throw new ApiError('bookmarks', r.status)
  return (await r.json()).bookmarks
}

export async function tasksDue(vault: string): Promise<DueTask[]> {
  const r = await req(`/api/tasks/due?vault=${encodeURIComponent(vault)}`, { headers: authHeaders() })
  if (!r.ok) throw new ApiError('tasks', r.status)
  return (await r.json()).tasks
}

export async function transcribe(wav: Blob): Promise<{ text: string; cost: number; seconds: number }> {
  const r = await req(`/api/transcribe${keyPathQ()}`, { method: 'POST', headers: authHeaders(), body: wav })
  if (!r.ok) throw new ApiError('transcribe', r.status)
  return r.json()
}

// Append a line to an existing note. baseMtime guards a lost update; pass undefined to force the
// append (skip the compare-and-swap) — used for the user's explicit "add it anyway" after a conflict.
export async function appendNote(vault: string, path: string, text: string, baseMtime?: string): Promise<{ ok?: boolean; mtime?: string; vault?: string; path?: string; error?: string }> {
  const body: Record<string, unknown> = { vault, path, text }
  if (baseMtime !== undefined) body.base_mtime = baseMtime
  const r = await req(`/api/append`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) })
  return r.json() // 200 ok / 409 conflict / 404 — caller inspects
}

// Voice quick-capture -> the backend resolves today's daily note (or inbox) and appends.
export async function capture(text: string, opts: { vault?: string; mode?: string } = {}): Promise<{ ok?: boolean; vault?: string; path?: string; label?: string; created?: boolean; mtime?: string; error?: string }> {
  const r = await req(`/api/capture`, {
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ text, ...opts }),
  })
  return r.json()
}

export async function captureTarget(mode?: string): Promise<CaptureTarget> {
  const q = mode ? `?mode=${encodeURIComponent(mode)}` : ''
  const r = await req(`/api/capture/target${q}`, { headers: authHeaders() })
  if (!r.ok) throw new ApiError('capture/target', r.status)
  return r.json()
}
