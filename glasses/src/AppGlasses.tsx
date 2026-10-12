import { useEffect, useSyncExternalStore } from 'react'
import { useGlasses } from 'even-toolkit/useGlasses'
import { EvenAppBridge, OsEventTypeList, pickLoose, waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import {
  getSnapshot, subscribe, refresh,
  enterDir, goUp, goHome, openNote, scrollReader,
  startSearch, stopSearchVoice, cancelSearch,
  startQuickCapture, startNoteCapture, stopCaptureVoice, redoCapture, commitCapture, cancelCapture,
  openJump, openToday, loadRecent, loadBookmarks, loadTasks, loadVaults,
  openReaderJump, openFromList, returnToList, switchVault, setReaderScroll, popReader, openCaptured, cycleCaptureTarget, scrollCapture,
  type AppState,
} from './store'
import { router, type Ctx } from './screens'

// root double-tap -> hand off to the foreground layer's system exit dialog (exitMode 1)
const exitApp = () => { waitForEvenAppBridge().then((b) => b.shutDownPageContainer(1)).catch(() => {}) }

// --- shared-bridge hooks (the same singleton even-toolkit drives) ---
const bridge = EvenAppBridge.getInstance()

// even-toolkit maps an event with NO eventType to a tap (a click's type is 0, which the host omits).
// An event type this SDK build doesn't know ALSO parses to "no type" — that is how a long-press
// arrived as a tap on SDK 0.0.11 (in the reader a tap starts voice capture). Drop anything the SDK
// can't name before any listener (even-toolkit's included) sees it, so a future gesture can't do the
// same. On 0.0.16 a long-press (9/10) is known, and even-toolkit ignores it. (Same guard as G2C.)
const listen = bridge.onEvenHubEvent.bind(bridge)
bridge.onEvenHubEvent = (cb) => listen((e) => {
  const ev = e.listEvent ?? e.textEvent ?? e.sysEvent
  if (ev && ev.eventType == null) {
    const raw = pickLoose(e.jsonData ?? {}, 'eventType')
    if (raw != null && OsEventTypeList.fromJson(raw) === undefined) return
  }
  cb(e)
})

// Contextual menu (SDK 0.0.14+, Even app 2.2.9+): the OS overlay raised by tap-then-hold. even-toolkit
// builds every page itself with no menu hook, and the host REPLACES the menu on each build (omitting
// it clears it) — so carry our items on every page build. On an older Even app this is a no-op.
const MENU_CAPTURE = 1, MENU_SEARCH = 2, MENU_HOME = 3
const menuObject = { menuItems: [
  { itemName: 'Quick capture', itemID: MENU_CAPTURE },
  { itemName: 'Search this vault', itemID: MENU_SEARCH },
  { itemName: 'Vault home', itemID: MENU_HOME },
] }
for (const m of ['createStartUpPageContainer', 'rebuildPageContainer'] as const) {
  const build = (bridge[m] as (c: object) => Promise<unknown>).bind(bridge)
  ;(bridge as unknown as Record<string, unknown>)[m] = (c: object) => build(Object.assign(c, { menuObject }))
}

// A menu click arrives outside even-toolkit's gesture pipeline, which owns the current screen. Route it
// back in: remember the item, then send the Enter key even-toolkit's keyboard binding turns into a
// "select" action; onGlassAction runs the pending item instead, so the screen changes through the
// normal router and double-tap back behaves as usual. The item expires quickly, so a key that never
// arrives can't turn a later real tap into a menu action.
let pendingMenu: { id: number; at: number } | null = null
function onMenuClick(id: number) {
  pendingMenu = { id, at: Date.now() }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
}
type Nav = { screen: string; highlightedIndex: number }
function runMenu(id: number, nav: Nav, s: AppState): Nav {
  if (!s.configured || s.loading || !s.vault) return nav             // not set up / still connecting
  if (nav.screen === 'capture' && s.capPhase === 'busy') return nav   // never interrupt a save
  const ret = nav.screen === 'reader' ? 'reader' : nav.screen === 'capture' ? s.capReturn : 'browser'
  if (nav.screen === 'search') cancelSearch()                        // leave a listening input (stops the mic)
  if (nav.screen === 'capture') cancelCapture()
  if (id === MENU_CAPTURE) { startQuickCapture(ret); return { screen: 'capture', highlightedIndex: 0 } }
  if (id === MENU_SEARCH) { startSearch(); return { screen: 'search', highlightedIndex: 0 } }
  if (id === MENU_HOME) { void goHome(); return { screen: 'browser', highlightedIndex: 0 } }
  return nav
}

const ctx: Ctx = {
  exitApp, refresh,
  enterDir, goUp, openNote, scrollReader,
  startSearch, stopSearchVoice, cancelSearch,
  startQuickCapture, startNoteCapture, stopCaptureVoice, redoCapture, commitCapture, cancelCapture,
  openJump, openToday, loadRecent, loadBookmarks, loadTasks, loadVaults,
  openReaderJump, openFromList, returnToList,
  switchVault, setReaderScroll, popReader, openCaptured, cycleCaptureTarget, scrollCapture,
}

export function App() {
  useSyncExternalStore(subscribe, getSnapshot) // re-render -> re-push glasses display on store change

  useEffect(() => {
    refresh()
    // (re)launch from the phone app menu OR the glasses menu -> pull a fresh vault list
    let unsub: (() => void) | undefined
    let unsubMenu: (() => void) | undefined
    waitForEvenAppBridge()
      .then((b) => {
        unsub = b.onLaunchSource(() => { refresh() })
        unsubMenu = b.onEvenHubEvent((e) => { const id = e.menuItemClickEvent?.itemID; if (id) onMenuClick(id) })
      })
      .catch(() => {})
    return () => { unsub?.(); unsubMenu?.() }
  }, [])

  useGlasses<AppState>({
    appName: 'Gbsidian',
    getSnapshot,
    columns: [{ x: 0, w: 576 }], // single full-width column => flush-left, no 2-space prefix
    toDisplayData: (s, nav) => router.toDisplayData(s, nav),
    toColumns: (s, nav) => ({ columns: [router.toDisplayData(s, nav).lines.map((l) => l.text).join('\n')] }),
    onGlassAction: (a, nav, s) => {
      if (pendingMenu && a.type === 'SELECT_HIGHLIGHTED') {
        const m = pendingMenu
        pendingMenu = null
        if (Date.now() - m.at < 1000) return runMenu(m.id, nav, s)
      }
      return router.onGlassAction(a, nav, s, ctx)
    },
    deriveScreen: () => 'browser',
    // Lists + reader + capture use 'columns' (full-bleed; forwards swipe->scroll/-select on the real
    // G2). Only the search INPUT screen uses 'text' (styled prompt; it has no swipe action).
    getPageMode: (screen) => {
      const s = getSnapshot()
      if (screen === 'search' && s.searchPhase === 'input') return 'text'
      return 'columns'
    },
  })

  return null
}
