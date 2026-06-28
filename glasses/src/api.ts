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

// mtime is the write compare-and-swap token — a STRING (nanoseconds overflow JS number precision).
export interface Entry { name: string; type: 'dir' | 'note'; file?: string; mtime: number; size?: number }
export interface ListResult { vault: string; path: string; parent: string; entries: Entry[] }
export interface Note { vault: string; path: string; title: string; tags: string[]; aliases: string[]; lines: string[]; mtime: string; size: number }
export interface SearchResult { path: string; title: string; score: number; snippet: string; mtime: number }
export interface CaptureTarget { vault: string; path: string; exists: boolean; label: string; mode: string }

export async function health(): Promise<{ ok: boolean; voice: boolean; vaults: string[]; checked?: string[] }> {
  const r = await fetch(`${base()}/api/health${keyPathQ()}`, { headers: authHeaders() })
  if (!r.ok) throw new Error(`health ${r.status}`)
  return r.json()
}

export async function listVaults(): Promise<string[]> {
  const r = await fetch(`${base()}/api/vaults`, { headers: authHeaders() })
  if (!r.ok) throw new Error(`vaults ${r.status}`)
  return (await r.json()).vaults.map((v: { name: string }) => v.name)
}

export async function listDir(vault: string, path: string): Promise<ListResult> {
  const r = await fetch(`${base()}/api/list?vault=${encodeURIComponent(vault)}&path=${encodeURIComponent(path)}`, { headers: authHeaders() })
  if (!r.ok) throw new Error(`list ${r.status}`)
  return r.json()
}

export async function getNote(vault: string, path: string): Promise<Note> {
  const r = await fetch(`${base()}/api/note?vault=${encodeURIComponent(vault)}&path=${encodeURIComponent(path)}`, { headers: authHeaders() })
  if (!r.ok) throw new Error(`note ${r.status}`)
  return r.json()
}

export async function search(vault: string, q: string): Promise<SearchResult[]> {
  const r = await fetch(`${base()}/api/search?vault=${encodeURIComponent(vault)}&q=${encodeURIComponent(q)}`, { headers: authHeaders() })
  if (!r.ok) throw new Error(`search ${r.status}`)
  return (await r.json()).results
}

export async function transcribe(wav: Blob): Promise<{ text: string; cost: number; seconds: number }> {
  const r = await fetch(`${base()}/api/transcribe${keyPathQ()}`, { method: 'POST', headers: authHeaders(), body: wav })
  if (!r.ok) throw new Error(`transcribe ${r.status}`)
  return r.json()
}

// Append a line to an existing note (the note you're reading). base_mtime guards a lost update.
export async function appendNote(vault: string, path: string, text: string, baseMtime: string): Promise<{ ok?: boolean; mtime?: string; error?: string }> {
  const r = await fetch(`${base()}/api/append`, {
    method: 'POST', headers: jsonHeaders(),
    body: JSON.stringify({ vault, path, text, base_mtime: baseMtime }),
  })
  return r.json() // 200 ok / 409 conflict / 404 — caller inspects
}

// Voice quick-capture -> the backend resolves today's daily note (or inbox) and appends.
export async function capture(text: string): Promise<{ ok?: boolean; vault?: string; path?: string; label?: string; created?: boolean; mtime?: string; error?: string }> {
  const r = await fetch(`${base()}/api/capture`, {
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ text }),
  })
  return r.json()
}

export async function captureTarget(): Promise<CaptureTarget> {
  const r = await fetch(`${base()}/api/capture/target`, { headers: authHeaders() })
  if (!r.ok) throw new Error(`capture/target ${r.status}`)
  return r.json()
}
