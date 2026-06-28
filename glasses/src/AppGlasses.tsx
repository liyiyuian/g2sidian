import { useEffect, useSyncExternalStore } from 'react'
import { useGlasses } from 'even-toolkit/useGlasses'
import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import {
  getSnapshot, subscribe, refresh,
  enterDir, goUp, openNote, scrollReader,
  startSearch, stopSearchVoice, cancelSearch,
  startQuickCapture, startNoteCapture, stopCaptureVoice, redoCapture, commitCapture, cancelCapture,
  type AppState,
} from './store'
import { router, type Ctx } from './screens'

// root double-tap -> hand off to the foreground layer's system exit dialog (exitMode 1)
const exitApp = () => { waitForEvenAppBridge().then((b) => b.shutDownPageContainer(1)).catch(() => {}) }

const ctx: Ctx = {
  exitApp,
  enterDir, goUp, openNote, scrollReader,
  startSearch, stopSearchVoice, cancelSearch,
  startQuickCapture, startNoteCapture, stopCaptureVoice, redoCapture, commitCapture, cancelCapture,
}

export function App() {
  useSyncExternalStore(subscribe, getSnapshot) // re-render -> re-push glasses display on store change

  useEffect(() => {
    refresh()
    // (re)launch from the phone app menu OR the glasses menu -> pull a fresh vault list
    let unsub: (() => void) | undefined
    waitForEvenAppBridge()
      .then((b) => { unsub = b.onLaunchSource(() => { refresh() }) })
      .catch(() => {})
    return () => { unsub?.() }
  }, [])

  useGlasses<AppState>({
    appName: 'G2sidian',
    getSnapshot,
    columns: [{ x: 0, w: 576 }], // single full-width column => flush-left, no 2-space prefix
    toDisplayData: (s, nav) => router.toDisplayData(s, nav),
    toColumns: (s, nav) => ({ columns: [router.toDisplayData(s, nav).lines.map((l) => l.text).join('\n')] }),
    onGlassAction: (a, nav, s) => router.onGlassAction(a, nav, s, ctx),
    deriveScreen: () => 'browser',
    // Lists + reader use 'columns' (full-bleed; forwards swipe->scroll on the real G2). The
    // capture/search INPUT screens use 'text' (styled prompt, small left margin is fine there).
    getPageMode: (screen) => {
      const s = getSnapshot()
      if (screen === 'capture') return 'text'
      if (screen === 'search' && s.searchPhase === 'input') return 'text'
      return 'columns'
    },
  })

  return null
}
