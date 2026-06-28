import { useSyncExternalStore, type CSSProperties } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { App } from './AppGlasses'
import { Setup } from './Setup'
import { loadPersistedConfig } from './config'
import { subscribe, getSnapshot, submitTypedInput, setTypingText, cancelInput, awaitingTypedInput, refresh } from './store'

// Phone-side TEXT input — the alternative to voice at any "listening" point (search query, note
// capture). Shows whenever the glasses are waiting for input, so the app is fully usable even
// without an OpenAI key. Submits the typed text where voice would go.
function PhoneInput() {
  const s = useSyncExternalStore(subscribe, getSnapshot)
  if (!awaitingTypedInput()) return null
  const isSearch = s.inputMode === 'search'
  const label = isSearch ? `Search ${s.vault}` : `Note → ${s.capLabel}`
  const ph = isSearch ? 'search your notes…' : 'your note…'
  const send = () => submitTypedInput()
  const wrap: CSSProperties = { position: 'fixed', left: 0, right: 0, bottom: 0, background: '#0b0f0c', borderTop: '1px solid #173a26', padding: 14, fontFamily: 'system-ui, sans-serif', boxSizing: 'border-box' }
  const inp: CSSProperties = { width: '100%', padding: '12px 14px', fontSize: 16, borderRadius: 10, border: '1px solid #1f6e45', background: '#0f1712', color: '#e8fff1', boxSizing: 'border-box' }
  const btn: CSSProperties = { flex: 1, padding: '12px', fontSize: 15, fontWeight: 600, borderRadius: 10, border: 'none', background: '#16c46a', color: '#04130a' }
  return (
    <div style={wrap}>
      <div style={{ color: '#7fd9a6', fontSize: 13, marginBottom: 6 }}>{label}{s.voiceOn ? ' (or speak on the glasses)' : ''}</div>
      {!s.voiceOn && (
        <div style={{ color: '#88a895', fontSize: 11, marginBottom: 8, lineHeight: 1.4 }}>
          Voice off — no OpenAI key found on the backend{s.voiceChecked.length ? `. Checked: ${s.voiceChecked.join(' · ')}` : ''}. Type here, or add the key + set its path in Settings.
        </div>
      )}
      <textarea style={{ ...inp, minHeight: 48, resize: 'vertical' }} value={s.typingText} autoFocus
        onChange={(e) => setTypingText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
        placeholder={ph} autoCapitalize="sentences" autoCorrect="on" spellCheck={true} />
      {s.capStatus && <div style={{ color: '#ffb38a', fontSize: 12, marginTop: 4 }}>{s.capStatus}</div>}
      <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
        <button style={btn} onClick={send}>Send</button>
        <button style={{ ...btn, background: 'transparent', color: '#88a895', border: '1px solid #1f6e45' }} onClick={() => cancelInput()}>Cancel</button>
      </div>
    </div>
  )
}

// Phone-side root: the phone is a config + type-on-phone surface (the real UI is on the glasses),
// so it ALWAYS shows Settings. <App/> runs in the background driving the glasses (renders null in
// the DOM); PhoneInput overlays when input is needed. (App uses useGlasses, which needs a Router.)
function Root() {
  return (
    <>
      <MemoryRouter><App /></MemoryRouter>
      <Setup onSave={() => { refresh() }} />
      <PhoneInput />
    </>
  )
}

// Seed config from the phone app's persistent store (survives reinstall) BEFORE first render.
loadPersistedConfig().finally(() => createRoot(document.getElementById('root')!).render(<Root />))
