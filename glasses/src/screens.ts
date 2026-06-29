// Screen router: vaults -> browser <-> reader, with search + capture overlays.
// Lists render in COLUMNS page mode (forwards swipe->scroll on the real G2), which flattens line
// styles — so the selected row is marked with a ▶ TEXT marker, not an inverted style.
import { line, glassHeader, type DisplayData } from 'even-toolkit/types'
import { buildScrollableList } from 'even-toolkit/glass-display-builders'
import { wrapIndex } from 'even-toolkit/glass-nav'
import { truncateGlassText } from 'even-toolkit/pretext'
import { createGlassScreenRouter, type GlassScreen } from 'even-toolkit/glass-screen-router'
import type { AppState } from './store'
import type { Entry, SearchResult } from './api'

export interface Ctx {
  exitApp: () => void
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
}

const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + '…')
const SEL = (on: boolean) => (on ? '▶ ' : '   ')
const VIS = 8
const SLOTS = 9

// --- browser: folder tree of the chosen vault. Rows 0/1 = Quick capture / Search; then entries.
//     (the vault itself is chosen on the PHONE, so there's no on-glasses vault list.) ---
const ACTION_ROWS = 2
type BrowseRow = { cap: true } | { search: true } | { entry: Entry }
const browserScreen: GlassScreen<AppState, Ctx> = {
  display(s, nav): DisplayData {
    if (s.loading) return { lines: [...glassHeader('Gbsidian'), line('connecting…', 'meta')] }
    if (s.error) return { lines: [...glassHeader('Gbsidian', 'offline'), line(clip(s.error, 30), 'meta')] }
    const items: BrowseRow[] = [{ cap: true }, { search: true }, ...s.entries.map((entry) => ({ entry }))]
    const list = buildScrollableList({
      items, highlightedIndex: nav.highlightedIndex, maxVisible: VIS,
      formatter: (it, i) => {
        const body = 'cap' in it ? '» Quick capture'
          : 'search' in it ? '» Search this vault'
          : (it.entry.type === 'dir' ? it.entry.name + '/' : it.entry.name)
        return truncateGlassText(SEL(i === nav.highlightedIndex) + body)
      },
    })
    const where = s.path ? `${s.vault}/${s.path}` : s.vault
    const back = s.path ? '◀◀=up' : '◀◀=exit'
    return { lines: [...glassHeader(clip(where || 'Gbsidian', 34), `tap=open ${back}`), ...list] }
  },
  action(a, nav, s, ctx) {
    const total = s.entries.length + ACTION_ROWS
    if (a.type === 'HIGHLIGHT_MOVE') return { ...nav, highlightedIndex: wrapIndex(nav.highlightedIndex, a.direction, total) }
    if (a.type === 'SELECT_HIGHLIGHTED') {
      if (nav.highlightedIndex === 0) { ctx.startQuickCapture(); return { screen: 'capture', highlightedIndex: 0 } }
      if (nav.highlightedIndex === 1) { ctx.startSearch(); return { screen: 'search', highlightedIndex: 0 } }
      const e = s.entries[nav.highlightedIndex - ACTION_ROWS]
      if (e) {
        if (e.type === 'dir') { ctx.enterDir(e.name); return { screen: 'browser', highlightedIndex: 0 } }
        ctx.openNote(s.path ? `${s.path}/${e.file}` : e.file!, nav.highlightedIndex, 'browser')
        return { screen: 'reader', highlightedIndex: 0 }
      }
    }
    if (a.type === 'GO_BACK') {
      if (!s.path) { ctx.exitApp(); return nav }  // at vault root -> system exit dialog
      ctx.goUp(); return { screen: 'browser', highlightedIndex: 0 }
    }
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

// --- reader: the note, scrollable; tap = voice-append to this note ---
const readerScreen: GlassScreen<AppState, Ctx> = {
  display(s): DisplayData {
    const total = s.lines.length
    const top = Math.max(0, Math.min(s.scroll, maxScroll(total)))
    const win = s.lines.slice(top, top + SLOTS)
    const up = top > 0 ? '▲' : ' '
    const dn = top + SLOTS < total ? '▼' : ' '
    return { lines: [
      line(truncateGlassText(`${clip(s.noteTitle, 24)} ${up}${dn} tap=add ◀◀=back`), 'normal'),
      ...win.map((l) => line(truncateGlassText(l), 'meta')),
    ] }
  },
  action(a, nav, s, ctx) {
    if (a.type === 'HIGHLIGHT_MOVE') { ctx.scrollReader(a.direction); return nav }
    if (a.type === 'SELECT_HIGHLIGHTED') { ctx.startNoteCapture(); return { screen: 'capture', highlightedIndex: 0 } }
    if (a.type === 'GO_BACK') {
      if (s.readerFrom === 'search') return { screen: 'search', highlightedIndex: 0 }
      return { screen: 'browser', highlightedIndex: s.browseIndex }
    }
    return nav
  },
}

// --- capture: listening -> confirm -> busy -> done ---
const captureScreen: GlassScreen<AppState, Ctx> = {
  display(s): DisplayData {
    if (s.capPhase === 'listening') {
      const head = s.typingText ? 'TYPING' : (s.voiceOn ? 'LISTENING' : 'TYPE ON PHONE')
      return { lines: [
        ...glassHeader(`→ ${clip(s.capLabel, 18)}`, head),
        line('● ' + (s.typingText ? truncateGlassText(s.typingText) : (s.capStatus || (s.voiceOn ? 'Speak your note…' : 'Type your note on the phone…'))), 'normal'),
        line('', 'meta'),
        line(s.voiceOn ? 'Tap when done · type on phone · ◀◀ cancel' : 'Type on your phone · ◀◀ cancel', 'meta'),
      ] }
    }
    if (s.capPhase === 'busy') return { lines: [...glassHeader('CAPTURE', 'saving…'), line(s.capStatus || 'saving…', 'meta')] }
    if (s.capPhase === 'done') return { lines: [...glassHeader('CAPTURE', 'tap=ok ◀◀=back'), line('✓ ' + (s.capStatus || 'saved'), 'normal')] }
    // confirm
    const win = s.capLines.slice(0, SLOTS - 1)
    const more = s.capLines.length > win.length ? [line(`(+${s.capLines.length - win.length} more lines)`, 'meta')] : []
    const out = [line(truncateGlassText(`Save → ${clip(s.capLabel, 20)}  tap=SAVE ◀◀=redo`), 'normal'),
      ...win.map((l) => line(truncateGlassText(l), 'meta')), ...more]
    if (s.capStatus) out.push(line(truncateGlassText(s.capStatus), 'meta'))
    return { lines: out }
  },
  action(a, nav, s, ctx) {
    const back = () => ({ screen: s.capReturn, highlightedIndex: s.capReturn === 'reader' ? 0 : 0 })
    if (s.capPhase === 'listening') {
      if (a.type === 'SELECT_HIGHLIGHTED') ctx.stopCaptureVoice()
      else if (a.type === 'GO_BACK') { ctx.cancelCapture(); return back() }
      return nav
    }
    if (s.capPhase === 'confirm') {
      if (a.type === 'SELECT_HIGHLIGHTED') ctx.commitCapture()
      else if (a.type === 'GO_BACK') ctx.redoCapture()
      return nav
    }
    if (s.capPhase === 'done') {
      if (a.type === 'SELECT_HIGHLIGHTED' || a.type === 'GO_BACK') return back()
      return nav
    }
    return nav // busy: swallow
  },
}

function maxScroll(n: number) { return Math.max(0, n - SLOTS) }

export const router = createGlassScreenRouter<AppState, Ctx>({
  browser: browserScreen, search: searchScreen, reader: readerScreen, capture: captureScreen,
}, 'browser')
