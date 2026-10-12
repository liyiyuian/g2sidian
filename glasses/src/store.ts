// External store + actions for the Gbsidian glasses control flow.
// Screens (nav.screen): browser <-> reader, plus search / capture overlays, a Jump hub, and a
// generic list (recent / bookmarks / tasks-due / vault-switch / reader jump-to-link-or-heading).
//   browser : folder-tree browser (row0 = Quick capture, row1 = Search, row2 = Jump/find at root)
//   jump    : a hub of read-side jump targets (Read today / Recent / Bookmarks / Tasks due / Switch vault)
//   list    : a generic tappable list populated by the hub or the reader's jump overlay
//   reader  : the note, scrollable; tap = jump overlay (follow [[links]] / headings / add), or add
//   search  : phase input (voice/typed) -> results list
//   capture : phase listening -> confirm -> busy -> done (quick-capture OR append)
import { health, listVaults, listDir, getNote, search as apiSearch, transcribe, appendNote, capture as apiCapture, captureTarget, recent as apiRecent, bookmarks as apiBookmarks, tasksDue as apiTasksDue, ApiError, type Entry, type SearchResult, type Link } from './api'
import { getVault, setVault, getConfig } from './config'
import { GlassBridgeSource } from 'even-toolkit/stt'
import { getTextWidth } from 'even-toolkit/pretext'

export type CapPhase = 'listening' | 'confirm' | 'busy' | 'done'
export type SearchPhase = 'input' | 'results'
const DEBUG_VOICE = !!import.meta.env.VITE_DEBUG_VOICE

// --- generic list screen model ---
export type Act =
  | { t: 'open'; vault?: string; path: string; scrollEnd?: boolean; fromLink?: boolean }
  | { t: 'switchVault'; vault: string }
  | { t: 'capture' }
  | { t: 'scrollTo'; line: number }
export interface ListItem { label: string; sub?: string; act: Act }
export type ListKind = 'recent' | 'bookmarks' | 'tasks' | 'vault' | 'readerjump'
export type BackScreen = 'browser' | 'reader' | 'jump'
export interface ListState { kind: ListKind; title: string; back: BackScreen; items: ListItem[]; loading: boolean; error: string }

export interface CapDest { mode: 'note' | 'daily' | 'inbox'; label: string }
interface TodayTarget { path: string; vault: string; exists: boolean; label: string }
interface ReaderFrame { path: string; vault: string; scroll: number }

export interface AppState {
  loading: boolean
  error: string | null       // short, human connection-cause line for the glasses
  configured: boolean        // a backend URL is set (distinguishes "not set up" from "unreachable")
  voiceOn: boolean           // backend has an OpenAI key -> voice available
  voiceChecked: string[]

  vaults: string[]

  // browser
  vault: string
  path: string
  parent: string
  entries: Entry[]
  browseIndex: number

  // reader
  notePath: string
  noteTitle: string
  noteTags: string[]
  noteMtime: string          // write CAS token (string: ns overflows JS number precision)
  lines: string[]            // pixel-wrapped reader lines
  scroll: number
  readerFrom: 'browser' | 'search' | 'list'
  links: Link[]              // resolved outgoing [[wikilinks]] for tap-to-follow
  outline: { label: string; line: number }[]  // headings for tap-to-jump
  readerStack: ReaderFrame[] // back-stack for link following

  // jump hub
  today: TodayTarget | null

  // generic list
  list: ListState
  listReturn: { list: ListState; index: number } | null  // hub list a reader returns to on double-tap

  // search
  searchPhase: SearchPhase
  query: string
  results: SearchResult[]

  // capture
  capPhase: CapPhase
  capReturn: 'browser' | 'reader'
  capText: string
  capLines: string[]
  capLabel: string
  capStatus: string
  capScroll: number          // preview scroll on the confirm screen
  capConflict: boolean       // user chose "add anyway" -> next append skips the CAS check
  capTargets: CapDest[]      // destinations you can swipe through on the listening screen
  capTargetIdx: number
  capSavedVault: string      // where the last commit landed (done screen -> open it)
  capSavedPath: string

  inputMode: 'none' | 'search' | 'capture'
  typingText: string
  lastCost: number
  totalCost: number
}

const EMPTY_LIST: ListState = { kind: 'recent', title: '', back: 'jump', items: [], loading: false, error: '' }

let state: AppState = {
  loading: true, error: null, configured: false, voiceOn: true, voiceChecked: [],
  vaults: [],
  vault: '', path: '', parent: '', entries: [], browseIndex: 0,
  notePath: '', noteTitle: '', noteTags: [], noteMtime: '', lines: [], scroll: 0, readerFrom: 'browser',
  links: [], outline: [], readerStack: [],
  today: null,
  list: EMPTY_LIST, listReturn: null,
  searchPhase: 'input', query: '', results: [],
  capPhase: 'listening', capReturn: 'browser', capText: '', capLines: [], capLabel: '', capStatus: '',
  capScroll: 0, capConflict: false, capTargets: [], capTargetIdx: 0, capSavedVault: '', capSavedPath: '',
  inputMode: 'none', typingText: '', lastCost: 0, totalCost: 0,
}
const listeners = new Set<() => void>()
export function getSnapshot() { return state }
export function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } }
function set(p: Partial<AppState>) { state = { ...state, ...p }; listeners.forEach((l) => l()) }

const join = (a: string, b: string) => (a ? `${a}/${b}` : b)
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

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
function hangIndent(line: string): string {
  const m = line.match(/^(\s*)(•|\[[ x/\-?!]\]|\d+\.)\s/)
  return m ? ' '.repeat(m[1].length + (line.trimStart()[0] === '[' ? 4 : 2)) : ''
}
function softWrap(lines: string[]): string[] {
  const out: string[] = []
  for (const l of lines) { if (l === '') out.push(l); else out.push(...wrapPx(l, hangIndent(l))) }
  return out.length ? out : ['(empty note)']
}
function buildOutline(lines: string[]): { label: string; line: number }[] {
  const out: { label: string; line: number }[] = []
  lines.forEach((l, i) => { const m = l.match(/^(#{1,3})\s+(.+)/); if (m) out.push({ label: '  '.repeat(m[1].length - 1) + m[2].trim(), line: i }) })
  return out
}
function ageStr(secs: number): string {
  const d = Date.now() / 1000 - (secs || 0)
  if (d < 3600) return Math.max(1, Math.round(d / 60)) + 'm'
  if (d < 86400) return Math.round(d / 3600) + 'h'
  return Math.round(d / 86400) + 'd'
}
const shortErr = (e: unknown) => String((e as Error)?.message || e)
// The Recent / Bookmarks / Tasks-due lists need a backend from 0.3.0 on; an older one answers 404.
const listErr = (e: unknown) => ((e as ApiError)?.status === 404 ? 'Update backend: re-run install.sh' : shortErr(e))
function describeConnError(e: unknown): string {
  if (!getConfig().base) return 'Not set up yet'
  const status = (e as ApiError)?.status
  if (status === 401) return 'Token rejected — check your token in Setup'
  if ((e as Error)?.name === 'AbortError') return 'Timed out — backend slow or asleep'
  return "Can't reach your backend — check Tailscale + URL"
}

// --- boot / connection ---
export async function refresh() {
  try {
    const vaults = await listVaults()
    set({ vaults, loading: false, error: null, configured: true })
    health().then((h) => set({ voiceOn: h.voice, voiceChecked: h.checked || [] })).catch(() => {})
    const chosen = getVault()
    const active = chosen && vaults.includes(chosen) ? chosen : (vaults[0] || '')
    if (active) await loadDir(active, '', 0)
    else set({ vault: '', entries: [], error: 'No vaults configured on the backend' })
  } catch (e) { set({ loading: false, configured: !!getConfig().base, error: describeConnError(e) }) }
}

// --- browser ---
async function loadDir(vault: string, path: string, index = 0) {
  try {
    const r = await listDir(vault, path)
    set({ vault, path: r.path, parent: r.parent, entries: r.entries, browseIndex: index, error: null })
  } catch (e) { set({ error: describeConnError(e) }) }
}
export async function enterDir(name: string) { await loadDir(state.vault, join(state.path, name), 0) }
export async function goUp() { await loadDir(state.vault, state.parent, 0) }
export async function goHome() { await loadDir(state.vault, '', 0) }

// --- reader ---
interface OpenOpts { vault?: string; returnIndex?: number; from?: 'browser' | 'search' | 'list'; scrollEnd?: boolean; fromLink?: boolean; keepStack?: boolean }
export async function openNoteFull(relPath: string, opts: OpenOpts = {}) {
  const targetVault = opts.vault || state.vault
  const stack = opts.fromLink
    ? (state.notePath ? [...state.readerStack, { path: state.notePath, vault: state.vault, scroll: state.scroll }] : state.readerStack)
    : opts.keepStack ? state.readerStack : []
  set({
    readerStack: stack,
    browseIndex: opts.returnIndex ?? state.browseIndex,
    readerFrom: opts.from ?? state.readerFrom,
    lines: ['…'], scroll: 0, notePath: '', noteTitle: 'loading…', links: [], outline: [],
  })
  try {
    if (targetVault !== state.vault) await loadDir(targetVault, '', 0)
    const n = await getNote(targetVault, relPath)
    const raw = n.tags.length ? ['#' + n.tags.join(' #'), ''].concat(n.lines) : n.lines
    const lines = softWrap(raw)
    set({
      vault: targetVault, notePath: n.path, noteTitle: n.title, noteTags: n.tags, noteMtime: n.mtime,
      links: n.links || [], lines, outline: buildOutline(lines),
      scroll: opts.scrollEnd ? maxScroll(lines.length) : 0, error: null,
    })
  } catch (e) { set({ noteTitle: 'error', lines: [shortErr(e)] }) }
}
export async function openNote(relPath: string, returnIndex: number, from: 'browser' | 'search' = 'browser') {
  await openNoteFull(relPath, { returnIndex, from })
}
// pop one level of the link back-stack; returns false if empty (caller uses the normal back rule)
export async function popReader(): Promise<void> {
  const prev = state.readerStack[state.readerStack.length - 1]
  if (!prev) return
  set({ readerStack: state.readerStack.slice(0, -1) })
  await openNoteFull(prev.path, { vault: prev.vault, from: state.readerFrom, keepStack: true })
  set({ scroll: prev.scroll })
}
export function setReaderScroll(line: number) { set({ scroll: Math.max(0, Math.min(maxScroll(state.lines.length), line)) }) }

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

// --- jump hub + generic list ---
export function openJump() {
  set({ today: null })
  captureTarget().then((t) => set({ today: { path: t.path, vault: t.vault, exists: t.exists, label: t.label } })).catch(() => {})
}
export async function openToday() {
  try {
    const t = state.today || await captureTarget()  // prefetched by openJump; refetch on a race
    await openNoteFull(t.path, { vault: t.vault, from: 'browser', scrollEnd: true })
  } catch (e) { set({ noteTitle: 'error', lines: [shortErr(e)] }) }
}
export async function loadRecent() {
  set({ list: { kind: 'recent', title: 'Recently modified', back: 'jump', items: [], loading: true, error: '' } })
  try {
    const rs = await apiRecent(state.vault)
    const items: ListItem[] = rs.map((r) => ({ label: r.title, sub: ageStr(r.mtime), act: { t: 'open', path: r.path } }))
    set({ list: { kind: 'recent', title: 'Recently modified', back: 'jump', items, loading: false, error: '' } })
  } catch (e) { set({ list: { ...state.list, loading: false, error: listErr(e) } }) }
}
export async function loadBookmarks() {
  set({ list: { kind: 'bookmarks', title: 'Bookmarks', back: 'jump', items: [], loading: true, error: '' } })
  try {
    const bs = await apiBookmarks(state.vault)
    const items: ListItem[] = bs.map((b) => ({ label: b.title, sub: dirOf(b.path), act: { t: 'open', path: b.path } }))
    set({ list: { kind: 'bookmarks', title: 'Bookmarks', back: 'jump', items, loading: false, error: bs.length ? '' : 'No bookmarks in this vault' } })
  } catch (e) { set({ list: { ...state.list, loading: false, error: listErr(e) } }) }
}
export async function loadTasks() {
  set({ list: { kind: 'tasks', title: 'Tasks due', back: 'jump', items: [], loading: true, error: '' } })
  try {
    const ts = await apiTasksDue(state.vault)
    const items: ListItem[] = ts.map((t) => ({ label: (t.overdue ? '! ' : '') + t.desc, sub: (t.overdue ? 'overdue ' : '') + t.due.slice(5), act: { t: 'open', path: t.path } }))
    set({ list: { kind: 'tasks', title: 'Tasks due', back: 'jump', items, loading: false, error: ts.length ? '' : 'Nothing due — nice' } })
  } catch (e) { set({ list: { ...state.list, loading: false, error: listErr(e) } }) }
}
export function loadVaults() {
  const items: ListItem[] = state.vaults.map((v) => ({ label: v + (v === state.vault ? '  · current' : ''), act: { t: 'switchVault', vault: v } }))
  set({ list: { kind: 'vault', title: 'Switch vault', back: 'jump', items, loading: false, error: '' } })
}
export function openReaderJump() {
  const items: ListItem[] = [{ label: '» Add to this note', act: { t: 'capture' } }]
  for (const h of state.outline) items.push({ label: h.label, act: { t: 'scrollTo', line: h.line } })
  for (const lk of state.links) if (lk.path) items.push({ label: '→ ' + lk.label, act: { t: 'open', path: lk.path, fromLink: true } })
  set({ list: { kind: 'readerjump', title: state.noteTitle, back: 'reader', items, loading: false, error: '' } })
}
// true when the reader has somewhere to jump (links or headings) — else tap goes straight to capture
export function readerHasJumps(): boolean { return state.links.some((l) => l.path) || state.outline.length > 0 }
// Open a note from the generic list. A [[wikilink]] (fromLink) keeps the current origin and pushes the
// back-stack; a hub-list hit records the list + row so the reader's double-tap lands back on the list,
// not the folder tree. Snapshot is immutable, so a later openReaderJump can't clobber what we restore.
export function openFromList(act: Extract<Act, { t: 'open' }>, returnIndex = 0) {
  if (act.fromLink) {
    openNoteFull(act.path, { vault: act.vault, scrollEnd: act.scrollEnd, fromLink: true })
  } else {
    set({ listReturn: { list: state.list, index: returnIndex } })
    openNoteFull(act.path, { vault: act.vault, from: 'list', scrollEnd: act.scrollEnd })
  }
}
export function returnToList() { if (state.listReturn) set({ list: state.listReturn.list }) }
export async function switchVault(name: string) {
  if (!name) return
  setVault(name)
  await loadDir(name, '', 0)
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
  catch (e) { set({ capStatus: shortErr(e) }) }
}
export async function stopSearchVoice() {
  if (!state.voiceOn) return  // voice-off: tapping does nothing (type on the phone instead)
  stopMic()
  const t = await captureVoiceText('search the notes for…')
  if (t == null) { set({ searchPhase: 'input' }); beginMic(); return }
  await runSearch(t)
}
export function cancelSearch() { stopMic(); pcm = []; set({ searchPhase: 'input', query: '', results: [], capStatus: '', typingText: '', inputMode: 'none' }) }

// --- capture (quick-capture OR append-to-open-note) ---
export function startQuickCapture(returnTo: 'browser' | 'reader' = 'browser') {
  set({
    capReturn: returnTo, capPhase: 'listening', capText: '', capStatus: '', capLabel: 'Quick capture',
    typingText: '', inputMode: 'capture', capConflict: false, capScroll: 0,
    capTargets: [{ mode: 'daily', label: 'Daily note' }, { mode: 'inbox', label: 'Inbox' }], capTargetIdx: 0,
  })
  captureTarget().then((t) => {
    const tg = state.capTargets.slice(); tg[0] = { mode: 'daily', label: t.mode === 'daily' ? t.label : 'Daily note' }
    set({ capLabel: t.label, capTargets: tg, capTargetIdx: t.mode === 'inbox' ? 1 : 0 })
  }).catch(() => {})
  if (state.voiceOn) beginMic()
}
export function startNoteCapture() {
  set({
    capReturn: 'reader', capPhase: 'listening', capText: '', capStatus: '', capLabel: state.noteTitle,
    typingText: '', inputMode: 'capture', capConflict: false, capScroll: 0,
    capTargets: [{ mode: 'note', label: state.noteTitle }, { mode: 'daily', label: 'Daily note' }, { mode: 'inbox', label: 'Inbox' }], capTargetIdx: 0,
  })
  captureTarget().then((t) => { const tg = state.capTargets.slice(); tg[1] = { mode: 'daily', label: t.mode === 'daily' ? t.label : 'Daily note' }; set({ capTargets: tg }) }).catch(() => {})
  if (state.voiceOn) beginMic()
}
export function cycleCaptureTarget(dir: 'up' | 'down') {
  const n = state.capTargets.length
  if (n < 2) return
  set({ capTargetIdx: (state.capTargetIdx + (dir === 'down' ? 1 : n - 1)) % n })
}
export function scrollCapture(dir: 'up' | 'down') {
  const ms = Math.max(0, state.capLines.length - (SLOTS - 1))
  set({ capScroll: Math.max(0, Math.min(ms, state.capScroll + (dir === 'up' ? -1 : 1))) })
}
function setCaptureConfirm(text: string) {
  const body = softWrap(text.split('\n'))
  if (state.lastCost) { body.push(''); body.push(`voice $${state.lastCost.toFixed(4)} · total $${state.totalCost.toFixed(4)}`) }
  set({ capText: text, capLines: body, capPhase: 'confirm', capStatus: '', capScroll: 0 })
}
export async function stopCaptureVoice() {
  if (!state.voiceOn) return  // voice-off: tapping does nothing (type on the phone instead)
  stopMic()
  const t = await captureVoiceText(state.capReturn === 'reader' ? 'add to this note…' : 'capture a thought…')
  if (t == null) { set({ capPhase: 'listening' }); beginMic(); return }
  setCaptureConfirm(t)
}
export function redoCapture() { stopMic(); pcm = []; set({ capPhase: 'listening', capText: '', capStatus: '', capConflict: false, capScroll: 0 }); if (state.voiceOn) beginMic() }
export async function commitCapture() {
  const text = state.capText.trim()
  if (!text) return
  const tgt = state.capTargets[state.capTargetIdx] || { mode: state.capReturn === 'reader' ? 'note' : 'daily', label: '' }
  set({ capPhase: 'busy', capStatus: 'saving…' })
  try {
    if (tgt.mode === 'note') {
      const r = await appendNote(state.vault, state.notePath, text, state.capConflict ? undefined : state.noteMtime)
      if (r.ok && r.mtime) set({ noteMtime: r.mtime, capPhase: 'done', capStatus: 'added to ' + state.noteTitle, capConflict: false, capSavedVault: r.vault || state.vault, capSavedPath: r.path || state.notePath })
      else if (r.error && /changed on disk/.test(r.error)) set({ capPhase: 'confirm', capConflict: true, capStatus: 'changed in Obsidian — tap = add anyway' })
      else set({ capPhase: 'confirm', capStatus: r.error || 'save failed — tap to retry' })
    } else {
      const r = await apiCapture(text, { mode: tgt.mode })
      if (r.ok) set({ capPhase: 'done', capStatus: (r.created ? 'created ' : 'added to ') + (r.label || r.path || 'note'), capSavedVault: r.vault || state.vault, capSavedPath: r.path || '' })
      else set({ capPhase: 'confirm', capStatus: r.error || 'save failed — tap to retry' })
    }
  } catch (e) { set({ capPhase: 'confirm', capStatus: shortErr(e) }) }
}
export async function openCaptured() {
  if (state.capSavedPath) await openNoteFull(state.capSavedPath, { vault: state.capSavedVault, from: 'browser', scrollEnd: true })
}
export function cancelCapture() { stopMic(); pcm = []; set({ capPhase: 'listening', capText: '', capStatus: '', capConflict: false, capScroll: 0, typingText: '', inputMode: 'none' }) }

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
  if (t && mic) { stopMic(); pcm = [] }
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
