// Screen router: browser <-> reader, with search + capture overlays, a Jump hub, and a generic
// tappable list (recent / bookmarks / tasks-due / vault-switch / reader jump-to-link-or-heading).
// Lists render in COLUMNS page mode (forwards swipe->scroll on the real G2), which flattens line
// styles — so the selected row is marked with a ▶ TEXT marker, not an inverted style.
import { line, glassHeader, type DisplayData } from 'even-toolkit/types'
import { buildScrollableList } from 'even-toolkit/glass-display-builders'
import { wrapIndex } from 'even-toolkit/glass-nav'
import { truncateGlassText } from 'even-toolkit/pretext'
import { createGlassScreenRouter, type GlassScreen } from 'even-toolkit/glass-screen-router'
import type { AppState, Act } from './store'
import type { Entry, SearchResult } from './api'

export interface Ctx {
  exitApp: () => void
  refresh: () => void
  enterDir: (name: string) => void
  goUp: () => void
  openNote: (relPath: string, returnIndex: number, from: 'browser' | 'search') => void
  scrollReader: (dir: 'up' | 'down') => void
  startSearch: () => void
  stopSearchVoice: () => void
  cancelSearch: () => void
  startQuickCapture: () => void
  startNoteCapture: () => void
  stopCaptureVoice: () => void
  redoCapture: () => void
  commitCapture: () => void
  cancelCapture: () => void
  // jump hub + list
  openJump: () => void
  openToday: () => void
  loadRecent: () => void
  loadBookmarks: () => void
  loadTasks: () => void
  loadVaults: () => void
  openReaderJump: () => void
  openFromList: (act: Extract<Act, { t: 'open' }>, returnIndex: number) => void
  returnToList: () => void
  switchVault: (name: string) => void
  setReaderScroll: (line: number) => void
  popReader: () => void
  openCaptured: () => void
  cycleCaptureTarget: (dir: 'up' | 'down') => void
  scrollCapture: (dir: 'up' | 'down') => void
}

const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + '…')
const SEL = (on: boolean) => (on ? '▶ ' : '   ')
const VIS = 8
const SLOTS = 9
const hasJumps = (s: AppState) => s.links.some((l) => l.path) || s.outline.length > 0

// --- browser: folder tree of the chosen vault. Action rows first, then entries.
//     Root adds a "Jump / find" row (read-side jump targets); subfolders keep just capture+search. ---
type BrowseRow = { kind: 'cap' } | { kind: 'search' } | { kind: 'jump' } | { kind: 'entry'; entry: Entry }
function browserRows(s: AppState): BrowseRow[] {
  const actions: BrowseRow[] = s.path
    ? [{ kind: 'cap' }, { kind: 'search' }]
    : [{ kind: 'cap' }, { kind: 'search' }, { kind: 'jump' }]
  return [...actions, ...s.entries.map((entry) => ({ kind: 'entry', entry } as BrowseRow))]
}
const browserScreen: GlassScreen<AppState, Ctx> = {
  display(s, nav): DisplayData {
    if (s.loading) return { lines: [...glassHeader('Gbsidian'), line('connecting…', 'meta')] }
    if (s.error && !s.entries.length) {
      // a connection/setup problem -> a legible cause + a real next step (never a raw stack trace)
      const hint = s.configured ? 'tap=retry  ◀◀=exit' : 'Open Gbsidian on your phone'
      return { lines: [...glassHeader('Gbsidian', s.configured ? 'offline' : 'not set up'), line(clip(s.error, 34), 'normal'), line(hint, 'meta')] }
    }
    const rows = browserRows(s)
    const list = buildScrollableList({
      items: rows, highlightedIndex: nav.highlightedIndex, maxVisible: VIS,
      formatter: (it, i) => {
        const body = it.kind === 'cap' ? '» Quick capture'
          : it.kind === 'search' ? '» Search this vault'
          : it.kind === 'jump' ? '» Jump / find'
          : (it.entry.type === 'dir' ? it.entry.name + '/' : it.entry.name)
        return truncateGlassText(SEL(i === nav.highlightedIndex) + body)
      },
    })
    const where = s.path ? `${s.vault}/${s.path}` : s.vault
    const back = s.path ? '◀◀=up' : '◀◀=exit'
    const out = [...glassHeader(clip(where || 'Gbsidian', 34), `tap=open ${back}`), ...list]
    if (s.path && !s.entries.length) out.push(line('(empty folder)', 'meta'))
    return { lines: out }
  },
  action(a, nav, s, ctx) {
    if (s.error && !s.entries.length) {
      if (a.type === 'SELECT_HIGHLIGHTED') { ctx.refresh(); return nav }  // tap = retry
      if (a.type === 'GO_BACK') { ctx.exitApp(); return nav }
      return nav
    }
    const rows = browserRows(s)
    if (a.type === 'HIGHLIGHT_MOVE') return { ...nav, highlightedIndex: wrapIndex(nav.highlightedIndex, a.direction, rows.length) }
    if (a.type === 'SELECT_HIGHLIGHTED') {
      const it = rows[nav.highlightedIndex]
      if (!it) return nav
      if (it.kind === 'cap') { ctx.startQuickCapture(); return { screen: 'capture', highlightedIndex: 0 } }
      if (it.kind === 'search') { ctx.startSearch(); return { screen: 'search', highlightedIndex: 0 } }
      if (it.kind === 'jump') { ctx.openJump(); return { screen: 'jump', highlightedIndex: 0 } }
      const e = it.entry
      if (e.type === 'dir') { ctx.enterDir(e.name); return { screen: 'browser', highlightedIndex: 0 } }
      ctx.openNote(s.path ? `${s.path}/${e.file}` : e.file!, nav.highlightedIndex, 'browser')
      return { screen: 'reader', highlightedIndex: 0 }
    }
    if (a.type === 'GO_BACK') {
      if (!s.path) { ctx.exitApp(); return nav }  // at vault root -> system exit dialog
      ctx.goUp(); return { screen: 'browser', highlightedIndex: 0 }
    }
    return nav
  },
}

// --- jump hub: read-side "land where you live" targets (all reuse the already-built backend index) ---
const JUMP_LABELS = ['Read today', 'Recently modified', 'Bookmarks', 'Tasks due', 'Switch vault']
const jumpScreen: GlassScreen<AppState, Ctx> = {
  display(s, nav): DisplayData {
    const rows = JUMP_LABELS.map((l, i) => (i === 0 && s.today && !s.today.exists ? "Start today's note" : l))
    const list = buildScrollableList({
      items: rows, highlightedIndex: nav.highlightedIndex, maxVisible: VIS,
      formatter: (l, i) => truncateGlassText(SEL(i === nav.highlightedIndex) + '» ' + l),
    })
    return { lines: [...glassHeader('Jump / find', 'tap=go ◀◀=back'), ...list] }
  },
  action(a, nav, s, ctx) {
    if (a.type === 'HIGHLIGHT_MOVE') return { ...nav, highlightedIndex: wrapIndex(nav.highlightedIndex, a.direction, JUMP_LABELS.length) }
    if (a.type === 'SELECT_HIGHLIGHTED') {
      switch (nav.highlightedIndex) {
        case 0:
          if (s.today && !s.today.exists) { ctx.startQuickCapture(); return { screen: 'capture', highlightedIndex: 0 } }
          ctx.openToday(); return { screen: 'reader', highlightedIndex: 0 }
        case 1: ctx.loadRecent(); return { screen: 'list', highlightedIndex: 0 }
        case 2: ctx.loadBookmarks(); return { screen: 'list', highlightedIndex: 0 }
        case 3: ctx.loadTasks(); return { screen: 'list', highlightedIndex: 0 }
        case 4: ctx.loadVaults(); return { screen: 'list', highlightedIndex: 0 }
      }
    }
    if (a.type === 'GO_BACK') return { screen: 'browser', highlightedIndex: 0 }
    return nav
  },
}

// --- generic list: recent / bookmarks / tasks / vault / reader-jump. Items carry an Act. ---
const listScreen: GlassScreen<AppState, Ctx> = {
  display(s, nav): DisplayData {
    const L = s.list
    if (L.loading) return { lines: [...glassHeader(clip(L.title || 'List', 30), '…'), line('loading…', 'meta')] }
    if (!L.items.length) return { lines: [...glassHeader(clip(L.title || 'List', 30), '◀◀=back'), line(L.error || '(empty)', 'meta')] }
    const list = buildScrollableList({
      items: L.items, highlightedIndex: nav.highlightedIndex, maxVisible: VIS,
      formatter: (it, i) => truncateGlassText(SEL(i === nav.highlightedIndex) + it.label + (it.sub ? '  — ' + it.sub : '')),
    })
    return { lines: [...glassHeader(clip(L.title || 'List', 30), 'tap=open ◀◀=back'), ...list] }
  },
  action(a, nav, s, ctx) {
    const items = s.list.items
    if (a.type === 'HIGHLIGHT_MOVE') return { ...nav, highlightedIndex: wrapIndex(nav.highlightedIndex, a.direction, Math.max(1, items.length)) }
    if (a.type === 'SELECT_HIGHLIGHTED') {
      const it = items[nav.highlightedIndex]
      if (!it) return nav
      const act = it.act
      if (act.t === 'open') { ctx.openFromList(act, nav.highlightedIndex); return { screen: 'reader', highlightedIndex: 0 } }
      if (act.t === 'switchVault') { ctx.switchVault(act.vault); return { screen: 'browser', highlightedIndex: 0 } }
      if (act.t === 'capture') { ctx.startNoteCapture(); return { screen: 'capture', highlightedIndex: 0 } }
      if (act.t === 'scrollTo') { ctx.setReaderScroll(act.line); return { screen: 'reader', highlightedIndex: 0 } }
      return nav
    }
    if (a.type === 'GO_BACK') return { screen: s.list.back, highlightedIndex: 0 }
    return nav
  },
}

// --- search: input phase (voice/typed) -> results list ---
const searchScreen: GlassScreen<AppState, Ctx> = {
  display(s, nav): DisplayData {
    if (s.searchPhase === 'input') {
      const head = s.typingText ? 'TYPING' : (s.voiceOn ? 'LISTENING' : 'TYPE ON PHONE')
      return { lines: [
        ...glassHeader(`Search ${clip(s.vault, 18)}`, head),
        line('● ' + (s.typingText ? truncateGlassText(s.typingText) : (s.capStatus || (s.voiceOn ? 'Speak your search…' : 'Type your search on the phone…'))), 'normal'),
        line('', 'meta'),
        line(s.voiceOn ? 'Tap when done · type on phone · ◀◀ back' : 'Type on your phone · ◀◀ back', 'meta'),
      ] }
    }
    const items: SearchResult[] = s.results
    if (!items.length) return { lines: [...glassHeader(`"${clip(s.query, 20)}"`, '◀◀=back'), line(s.capStatus || 'no matches', 'meta')] }
    const list = buildScrollableList({
      items, highlightedIndex: nav.highlightedIndex, maxVisible: VIS,
      formatter: (r, i) => truncateGlassText(SEL(i === nav.highlightedIndex) + r.title + (r.snippet ? '  — ' + r.snippet : '')),
    })
    return { lines: [...glassHeader(`${items.length} hits · "${clip(s.query, 16)}"`, 'tap=open ◀◀=back'), ...list] }
  },
  action(a, nav, s, ctx) {
    if (s.searchPhase === 'input') {
      if (a.type === 'SELECT_HIGHLIGHTED') ctx.stopSearchVoice()
      else if (a.type === 'GO_BACK') { ctx.cancelSearch(); return { screen: 'browser', highlightedIndex: 0 } }
      return nav
    }
    if (a.type === 'HIGHLIGHT_MOVE') return { ...nav, highlightedIndex: wrapIndex(nav.highlightedIndex, a.direction, Math.max(1, s.results.length)) }
    if (a.type === 'SELECT_HIGHLIGHTED') {
      const r = s.results[nav.highlightedIndex]
      if (r) { ctx.openNote(r.path, 0, 'search'); return { screen: 'reader', highlightedIndex: 0 } }
    }
    if (a.type === 'GO_BACK') { ctx.cancelSearch(); return { screen: 'browser', highlightedIndex: 0 } }
    return nav
  },
}

// --- reader: the note, scrollable. tap = jump overlay (follow [[links]] / headings / add), or add
//     directly when the note has no links/headings; double-tap = back (pops the link stack first). ---
function maxScroll(n: number) { return Math.max(0, n - SLOTS) }
const readerScreen: GlassScreen<AppState, Ctx> = {
  display(s): DisplayData {
    const total = s.lines.length
    const top = Math.max(0, Math.min(s.scroll, maxScroll(total)))
    const win = s.lines.slice(top, top + SLOTS)
    const up = top > 0 ? '▲' : ' '
    const dn = top + SLOTS < total ? '▼' : ' '
    const tap = hasJumps(s) ? 'tap=menu' : 'tap=add'
    return { lines: [
      line(truncateGlassText(`${clip(s.noteTitle, 22)} ${up}${dn} ${tap} ◀◀=back`), 'normal'),
      ...win.map((l) => line(truncateGlassText(l), 'meta')),
    ] }
  },
  action(a, nav, s, ctx) {
    if (a.type === 'HIGHLIGHT_MOVE') { ctx.scrollReader(a.direction); return nav }
    if (a.type === 'SELECT_HIGHLIGHTED') {
      if (!s.notePath) return nav  // ignore taps while a note is still loading / errored
      if (hasJumps(s)) { ctx.openReaderJump(); return { screen: 'list', highlightedIndex: 0 } }
      ctx.startNoteCapture(); return { screen: 'capture', highlightedIndex: 0 }
    }
    if (a.type === 'GO_BACK') {
      if (s.readerStack.length) { ctx.popReader(); return { screen: 'reader', highlightedIndex: 0 } }
      if (s.readerFrom === 'search') return { screen: 'search', highlightedIndex: 0 }
      if (s.readerFrom === 'list') { ctx.returnToList(); return { screen: 'list', highlightedIndex: s.listReturn?.index ?? 0 } }
      return { screen: 'browser', highlightedIndex: s.browseIndex }
    }
    return nav
  },
}

// --- capture: listening (swipe = choose destination) -> confirm (swipe = scroll preview) -> busy -> done ---
const captureScreen: GlassScreen<AppState, Ctx> = {
  display(s): DisplayData {
    const dest = s.capTargets[s.capTargetIdx]?.label || s.capLabel
    if (s.capPhase === 'listening') {
      const head = s.typingText ? 'TYPING' : (s.voiceOn ? 'LISTENING' : 'TYPE ON PHONE')
      const swipe = s.capTargets.length > 1 ? ' · swipe=where' : ''
      return { lines: [
        ...glassHeader(`→ ${clip(dest, 18)}`, head),
        line('● ' + (s.typingText ? truncateGlassText(s.typingText) : (s.capStatus || (s.voiceOn ? 'Speak your note…' : 'Type your note on the phone…'))), 'normal'),
        line('', 'meta'),
        line((s.voiceOn ? 'Tap when done' : 'Type on your phone') + swipe + ' · ◀◀ cancel', 'meta'),
      ] }
    }
    if (s.capPhase === 'busy') return { lines: [...glassHeader('CAPTURE', 'saving…'), line(s.capStatus || 'saving…', 'meta')] }
    if (s.capPhase === 'done') return { lines: [...glassHeader('CAPTURE', s.capSavedPath ? 'tap=open ◀◀=ok' : '◀◀=ok'), line(s.capStatus || 'saved', 'normal')] }
    // confirm — scrollable preview (never save text you can't see)
    const vis = SLOTS - 1
    const total = s.capLines.length
    const top = Math.max(0, Math.min(s.capScroll, Math.max(0, total - vis)))
    const win = s.capLines.slice(top, top + vis)
    const up = top > 0 ? '▲' : ' '
    const dn = top + vis < total ? '▼' : ' '
    const out = [line(truncateGlassText(`Save → ${clip(dest, 18)} ${up}${dn} tap=SAVE ◀◀=redo`), 'normal'),
      ...win.map((l) => line(truncateGlassText(l), 'meta'))]
    if (s.capStatus) out.push(line(truncateGlassText(s.capStatus), 'meta'))
    return { lines: out }
  },
  action(a, nav, s, ctx) {
    const back = () => ({ screen: s.capReturn, highlightedIndex: 0 })
    if (s.capPhase === 'listening') {
      if (a.type === 'HIGHLIGHT_MOVE') { ctx.cycleCaptureTarget(a.direction); return nav }
      if (a.type === 'SELECT_HIGHLIGHTED') ctx.stopCaptureVoice()
      else if (a.type === 'GO_BACK') { ctx.cancelCapture(); return back() }
      return nav
    }
    if (s.capPhase === 'confirm') {
      if (a.type === 'HIGHLIGHT_MOVE') { ctx.scrollCapture(a.direction); return nav }
      if (a.type === 'SELECT_HIGHLIGHTED') ctx.commitCapture()
      else if (a.type === 'GO_BACK') ctx.redoCapture()
      return nav
    }
    if (s.capPhase === 'done') {
      if (a.type === 'SELECT_HIGHLIGHTED') { if (s.capSavedPath) { ctx.openCaptured(); return { screen: 'reader', highlightedIndex: 0 } } return back() }
      if (a.type === 'GO_BACK') return back()
      return nav
    }
    return nav // busy: swallow
  },
}

export const router = createGlassScreenRouter<AppState, Ctx>({
  browser: browserScreen, jump: jumpScreen, list: listScreen, search: searchScreen, reader: readerScreen, capture: captureScreen,
}, 'browser')
