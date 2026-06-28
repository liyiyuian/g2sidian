// External store + actions for the G2sidian glasses control flow.
// Screens (nav.screen): vaults -> browser <-> reader, plus search and capture overlays.
//   vaults  : pick a vault (row 0 = 🎤 quick capture)
//   browser : folder-tree browser (row 0 = 🔍 search); tap folder=descend, tap note=open
//   search  : phase input (voice/typed) -> results list
//   reader  : the note, scrollable; tap = voice-append to THIS note
//   capture : phase listening -> confirm -> busy -> done (quick-capture OR append-to-open-note)
import { health, listVaults, listDir, getNote, search as apiSearch, transcribe, appendNote, capture as apiCapture, captureTarget, type Entry, type SearchResult } from './api'
import { getVault } from './config'
import { GlassBridgeSource } from 'even-toolkit/stt'
import { getTextWidth } from 'even-toolkit/pretext'

export type CapPhase = 'listening' | 'confirm' | 'busy' | 'done'
export type SearchPhase = 'input' | 'results'
const DEBUG_VOICE = !!import.meta.env.VITE_DEBUG_VOICE

export interface AppState {
  loading: boolean
  error: string | null
  voiceOn: boolean        // backend has an OpenAI key -> voice available
  voiceChecked: string[]

  vaults: string[]

  // browser
  vault: string
  path: string
  parent: string
  entries: Entry[]
  browseIndex: number     // remembered cursor so reopening a folder/returning from a note resumes

  // reader
  notePath: string
  noteTitle: string
  noteTags: string[]
  noteMtime: string       // write CAS token (string: ns overflows JS number precision)
  lines: string[]         // pixel-wrapped reader lines
  scroll: number
  readerFrom: 'browser' | 'search'  // where GO_BACK from the reader returns

  // search
  searchPhase: SearchPhase
  query: string
  results: SearchResult[]

  // capture (voice/typed -> confirm -> commit)
  capPhase: CapPhase
  capReturn: 'browser' | 'reader'  // where double-tap/done returns
  capText: string
  capLines: string[]
  capLabel: string        // "Daily note 2026-06-28" or the open note's title
  capStatus: string

  inputMode: 'none' | 'search' | 'capture'  // which flow owns phone-typed input right now
  typingText: string      // live phone typing, echoed to glasses
  lastCost: number
  totalCost: number
}

let state: AppState = {
  loading: true, error: null, voiceOn: true, voiceChecked: [],
  vaults: [],
  vault: '', path: '', parent: '', entries: [], browseIndex: 0,
  notePath: '', noteTitle: '', noteTags: [], noteMtime: '', lines: [], scroll: 0, readerFrom: 'browser',
  searchPhase: 'input', query: '', results: [],
  capPhase: 'listening', capReturn: 'browser', capText: '', capLines: [], capLabel: '', capStatus: '',
  inputMode: 'none', typingText: '', lastCost: 0, totalCost: 0,
}
const listeners = new Set<() => void>()
export function getSnapshot() { return state }
export function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } }
function set(p: Partial<AppState>) { state = { ...state, ...p }; listeners.forEach((l) => l()) }

const join = (a: string, b: string) => (a ? `${a}/${b}` : b)

const SLOTS = 9
const maxScroll = (n: number) => Math.max(0, n - SLOTS)

// --- pixel-accurate word wrap (pretext getTextWidth), copied from the tmuxor reader ---
const WRAP_PX = 568
function wrapPx(line: string, indent = ''): string[] {
  if (getTextWidth(line) <= WRAP_PX) return [line]
  const out: string[] = []
  let cur = ''
  for (const w of line.split(' ')) {
    const trial = cur === '' ? w : cur + ' ' + w
    if (getTextWidth(trial) <= WRAP_PX) { cur = trial; continue }
    if (cur !== '') out.push(cur)
    if (getTextWidth(indent + w) > WRAP_PX) {
      let r = indent + w
      while (getTextWidth(r) > WRAP_PX) {
        let lo = 1, hi = r.length, k = 1
        while (lo <= hi) { const mid = (lo + hi) >> 1; if (getTextWidth(r.slice(0, mid)) <= WRAP_PX) { k = mid; lo = mid + 1 } else hi = mid - 1 }
        out.push(r.slice(0, k)); r = indent + r.slice(k)
      }
      cur = r
    } else { cur = indent + w }
  }
  if (cur !== '') out.push(cur)
  return out
}
// continuation indent: align wrapped bullet/task text under the first word
function hangIndent(line: string): string {
  const m = line.match(/^(\s*)(•|\[[ x/\-?!]\]|\d+\.)\s/)
  return m ? ' '.repeat(m[1].length + (line.trimStart()[0] === '[' ? 4 : 2)) : ''
}
function softWrap(lines: string[]): string[] {
  const out: string[] = []
  for (const l of lines) { if (l === '') out.push(l); else out.push(...wrapPx(l, hangIndent(l))) }
  return out.length ? out : ['(empty note)']
}

// --- boot / connection ---
// The active vault is chosen on the phone (Setup). Open straight into it; fall back to the first
// vault if nothing is chosen yet or the chosen one no longer exists.
export async function refresh() {
  try {
    const vaults = await listVaults()
    set({ vaults, loading: false, error: null })
    health().then((h) => set({ voiceOn: h.voice, voiceChecked: h.checked || [] })).catch(() => {})
    const chosen = getVault()
    const active = chosen && vaults.includes(chosen) ? chosen : (vaults[0] || '')
    if (active) await loadDir(active, '', 0)
    else set({ vault: '', entries: [], error: 'no vaults configured on the backend' })
  } catch (e) { set({ loading: false, error: String(e) }) }
}

// --- browser ---
async function loadDir(vault: string, path: string, index = 0) {
  try {
    const r = await listDir(vault, path)
    set({ vault, path: r.path, parent: r.parent, entries: r.entries, browseIndex: index, error: null })
  } catch (e) { set({ error: String(e) }) }
}
export async function enterDir(name: string) { await loadDir(state.vault, join(state.path, name), 0) }
export async function goUp() { await loadDir(state.vault, state.parent, 0) }

// --- reader ---
export async function openNote(relPath: string, returnIndex: number, from: 'browser' | 'search' = 'browser') {
  set({ browseIndex: returnIndex, readerFrom: from, lines: ['…'], scroll: 0, notePath: '', noteTitle: 'loading…' })
  try {
    const n = await getNote(state.vault, relPath)
    const lines = softWrap(n.lines)
    set({ notePath: n.path, noteTitle: n.title, noteTags: n.tags, noteMtime: n.mtime, lines, scroll: 0, error: null })
  } catch (e) { set({ noteTitle: 'error', lines: [String(e)] }) }
}
// velocity-aware scroll (copied from tmuxor): single swipe nudges, sustained swipes accelerate
const SCROLL_BASE = 2, SCROLL_GAIN = 3, SCROLL_MAX = 16, SCROLL_WINDOW_MS = 650
let scrollTs = 0, scrollDir: 'up' | 'down' | null = null, scrollStep = SCROLL_BASE
export function scrollReader(dir: 'up' | 'down') {
  const now = Date.now()
  const sustained = dir === scrollDir && now - scrollTs < SCROLL_WINDOW_MS
  scrollStep = sustained ? Math.min(SCROLL_MAX, scrollStep + SCROLL_GAIN) : SCROLL_BASE
  scrollTs = now; scrollDir = dir
  const ms = maxScroll(state.lines.length)
  set({ scroll: Math.max(0, Math.min(ms, state.scroll + (dir === 'up' ? -scrollStep : scrollStep))) })
}

// --- search ---
export function startSearch() {
  set({ searchPhase: 'input', query: '', results: [], capStatus: '', typingText: '', inputMode: 'search' })
  if (state.voiceOn) beginMic()
}
async function runSearch(q: string) {
  q = q.trim()
  if (!q) { set({ searchPhase: 'input', capStatus: 'say or type a search' }); if (state.voiceOn) beginMic(); return }
  set({ query: q, searchPhase: 'results', results: [], capStatus: 'searching…' })
  try { set({ results: await apiSearch(state.vault, q), capStatus: '' }) }
  catch (e) { set({ capStatus: String(e) }) }
}
export async function stopSearchVoice() {
  stopMic()
  const t = await captureVoiceText('search the notes for…')
  if (t == null) { set({ searchPhase: 'input' }); beginMic(); return }
  await runSearch(t)
}
export function cancelSearch() { stopMic(); pcm = []; set({ searchPhase: 'input', query: '', results: [], capStatus: '', typingText: '', inputMode: 'none' }) }

// --- capture (quick-capture OR append-to-open-note) ---
export function startQuickCapture() {
  set({ capReturn: 'browser', capPhase: 'listening', capText: '', capStatus: '', capLabel: 'Quick capture', typingText: '', inputMode: 'capture' })
  captureTarget().then((t) => set({ capLabel: t.label })).catch(() => {})
  if (state.voiceOn) beginMic()
}
export function startNoteCapture() {
  set({ capReturn: 'reader', capPhase: 'listening', capText: '', capStatus: '', capLabel: state.noteTitle, typingText: '', inputMode: 'capture' })
  if (state.voiceOn) beginMic()
}
function setCaptureConfirm(text: string) {
  const body = softWrap(text.split('\n'))
  if (state.lastCost) { body.push(''); body.push(`voice $${state.lastCost.toFixed(4)} · total $${state.totalCost.toFixed(4)}`) }
  set({ capText: text, capLines: body, capPhase: 'confirm', capStatus: '' })
}
export async function stopCaptureVoice() {
  stopMic()
  const t = await captureVoiceText(state.capReturn === 'reader' ? 'add to this note…' : 'capture a thought…')
  if (t == null) { set({ capPhase: 'listening' }); beginMic(); return }
  setCaptureConfirm(t)
}
export function redoCapture() { stopMic(); pcm = []; set({ capPhase: 'listening', capText: '', capStatus: '' }); if (state.voiceOn) beginMic() }
export async function commitCapture() {
  const text = state.capText.trim()
  if (!text) return
  set({ capPhase: 'busy', capStatus: 'saving…' })
  try {
    if (state.capReturn === 'reader') {
      const r = await appendNote(state.vault, state.notePath, text, state.noteMtime)
      if (r.ok && r.mtime) { set({ noteMtime: r.mtime, capPhase: 'done', capStatus: 'added to ' + state.noteTitle }) }
      else if (r.error && /changed on disk/.test(r.error)) set({ capPhase: 'confirm', capStatus: 'note changed in Obsidian — reopen it, then retry' })
      else set({ capPhase: 'confirm', capStatus: r.error || 'save failed — tap to retry' })
    } else {
      const r = await apiCapture(text)
      if (r.ok) set({ capPhase: 'done', capStatus: (r.created ? 'created ' : 'added to ') + (r.label || r.path || 'note') })
      else set({ capPhase: 'confirm', capStatus: r.error || 'save failed — tap to retry' })
    }
  } catch (e) { set({ capPhase: 'confirm', capStatus: String(e) }) }
}
export function cancelCapture() { stopMic(); pcm = []; set({ capPhase: 'listening', capText: '', capStatus: '', typingText: '', inputMode: 'none' }) }

// --- shared mic capture -> WAV -> Whisper. Returns text or null (status set). ---
let mic: GlassBridgeSource | null = null
let micUnsub: (() => void) | null = null
let pcm: Float32Array[] = []
let micRate = 16000
function stopMic() { try { micUnsub?.(); mic?.stop() } catch { /* ignore */ } micUnsub = null; mic = null }
function beginMic() {
  pcm = []
  try {
    mic = new GlassBridgeSource()
    micUnsub = mic.onAudioData((chunk, rate) => { pcm.push(chunk); micRate = rate })
    mic.start().catch(() => { stopMic(); set({ capStatus: 'mic unavailable — check microphone permission' }) })
  } catch { set({ capStatus: 'mic unavailable — check microphone permission' }) }
}
async function captureVoiceText(debug: string): Promise<string | null> {
  let text = ''
  if (pcm.length) {
    const wav = pcmToWav(pcm, micRate); pcm = []
    set({ capStatus: 'transcribing…' })
    try {
      const res = await transcribe(wav)
      text = res.text
      set({ lastCost: res.cost || 0, totalCost: state.totalCost + (res.cost || 0) })
    } catch { set({ capStatus: "didn't catch that — tap to retry" }); return null }
  } else if (DEBUG_VOICE) { text = debug }
  if (!text) { set({ capStatus: 'no speech — tap to retry' }); return null }
  return text
}

// --- phone-typed input: the alternative to voice at every listening point ---
export function setTypingText(t: string) {
  if (t && mic) { stopMic(); pcm = [] } // typing wins over an in-flight recording
  set({ typingText: t })
}
export async function submitTypedInput() {
  const t = state.typingText.trim()
  set({ typingText: '' })
  if (!t) return
  stopMic(); pcm = []
  if (state.inputMode === 'search') { await runSearch(t); return }
  if (state.inputMode === 'capture') setCaptureConfirm(t)
}
// Is phone-typed input being awaited right now? (main.tsx shows the textarea accordingly.)
export function awaitingTypedInput(): boolean {
  return (state.inputMode === 'search' && state.searchPhase === 'input') ||
    (state.inputMode === 'capture' && state.capPhase === 'listening')
}
export function cancelInput() {
  stopMic(); pcm = []
  if (state.inputMode === 'search') cancelSearch()
  else if (state.inputMode === 'capture') cancelCapture()
}

function pcmToWav(chunks: Float32Array[], sampleRate: number): Blob {
  const total = chunks.reduce((a, c) => a + c.length, 0)
  const flat = new Float32Array(total)
  let off = 0
  for (const c of chunks) { flat.set(c, off); off += c.length }
  const buf = new ArrayBuffer(44 + total * 2)
  const dv = new DataView(buf)
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); dv.setUint32(4, 36 + total * 2, true); w(8, 'WAVE'); w(12, 'fmt ')
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true)
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true)
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, total * 2, true)
  for (let i = 0; i < total; i++) {
    const s = Math.max(-1, Math.min(1, flat[i]))
    dv.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Blob([buf], { type: 'audio/wav' })
}
