import { useState, useSyncExternalStore, type CSSProperties } from 'react'
import { getConfig, setConfig, getVault, setVault, getOpenaiKeyPath, setOpenaiKeyPath } from './config'
import { listVaults } from './api'
import { subscribe, getSnapshot } from './store'

// Decode the `g2sidian:<base64>` blob that install.sh prints into a config.
function decodeBlob(text: string): { base: string; token: string } | null {
  try {
    const raw = text.trim().replace(/^g2sidian:/, '').replace(/-/g, '+').replace(/_/g, '/')
    const o = JSON.parse(atob(raw))
    const base = (o.base || '').trim(); const token = (o.token || '').trim()
    if (!/^https:\/\/.+/i.test(base) || !token) return null
    return { base, token }
  } catch { return null }
}

// Phone-side settings form. Each user points the app at THEIR OWN backend with THEIR OWN token —
// nothing is shipped in the app. Fastest path: paste the config code install.sh prints.
export function Setup({ onSave }: { onSave: () => void }) {
  const c = getConfig()
  const [base, setBase] = useState(c.base)
  const [token, setToken] = useState(c.token)
  const [blob, setBlob] = useState('')
  const [keyPath, setKeyPath] = useState(getOpenaiKeyPath())
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  // Live connection status (the phone's only status indicator) — <App/> loads vaults in the
  // background, so the store reflects whether the backend is reachable right now.
  const live = useSyncExternalStore(subscribe, getSnapshot)
  const configured = !!getConfig().base
  const status = !configured
    ? '○ Not set up yet — paste the config code below'
    : live.error ? '○ Can’t reach your backend — check the URL & token'
    : `● Connected — ${live.vaults.length} vault${live.vaults.length === 1 ? '' : 's'}${live.voiceOn ? ' · voice on' : ' · voice off'}`
  const statusColor = configured && !live.error ? '#16c46a' : '#ffb38a'

  // Test the connection before declaring success, so a wrong URL/token fails HERE (on the phone).
  const connect = async (b: string, t: string) => {
    setErr(''); setBusy(true)
    setConfig({ base: b, token: t })
    setOpenaiKeyPath(keyPath)
    try {
      await listVaults()
      onSave()
    } catch (e) {
      const msg = String((e as Error)?.message || e)
      setErr(/\b401\b/.test(msg) ? 'Token rejected — check your G2SIDIAN_TOKEN.'
        : "Can't reach the backend — check the URL, and that the service + `tailscale serve` are running.")
    } finally { setBusy(false) }
  }

  const applyBlob = () => { const cfg = decodeBlob(blob); cfg ? connect(cfg.base, cfg.token) : setErr('That config code is not valid — copy the whole line from install.sh.') }
  const save = () => {
    const b = base.trim()
    if (!/^https:\/\/.+/i.test(b)) { setErr('Backend URL must start with https://'); return }
    if (!token.trim()) { setErr('An access token is required (set G2SIDIAN_TOKEN on your backend).'); return }
    connect(b, token.trim())
  }

  const wrap: CSSProperties = { background: '#0b0f0c', color: '#d6ffe6', minHeight: '100vh', padding: 20, fontFamily: 'system-ui, sans-serif', boxSizing: 'border-box' }
  const label: CSSProperties = { display: 'block', fontSize: 13, color: '#7fd9a6', margin: '16px 0 6px' }
  const input: CSSProperties = { width: '100%', padding: '12px 14px', fontSize: 16, borderRadius: 10, border: '1px solid #1f6e45', background: '#0f1712', color: '#e8fff1', boxSizing: 'border-box' }
  const btn: CSSProperties = { marginTop: 14, width: '100%', padding: '14px', fontSize: 16, fontWeight: 600, borderRadius: 10, border: 'none', background: '#16c46a', color: '#04130a', opacity: busy ? 0.6 : 1 }
  const divider: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, margin: '22px 0 0', color: '#5f7a6b', fontSize: 12 }
  const rule: CSSProperties = { flex: 1, height: 1, background: '#1f6e45' }

  return (
    <div style={wrap}>
      <h2 style={{ margin: 0, fontSize: 20 }}>Gbsidian — Setup</h2>
      <p style={{ color: '#88a895', fontSize: 13, lineHeight: 1.4 }}>
        Run <code>install.sh</code> on the computer that holds your Obsidian vaults, then paste the config code it prints. Your notes stay on your machine.
      </p>
      <p style={{ color: statusColor, fontSize: 13, margin: '4px 0 0', fontWeight: 600 }}>{status}</p>

      {configured && !live.error && live.vaults.length > 0 && (
        <>
          <label style={label}>Vault — which one the glasses open into</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {live.vaults.map((v) => {
              const sel = v === (getVault() || live.vault)
              return (
                <button key={v} onClick={() => { setVault(v); onSave() }}
                  style={{ padding: '10px 14px', borderRadius: 10, fontSize: 14, border: '1px solid #1f6e45', cursor: 'pointer',
                           background: sel ? '#16c46a' : 'transparent', color: sel ? '#04130a' : '#d6ffe6', fontWeight: sel ? 600 : 400 }}>
                  {sel ? '✓ ' : ''}{v}
                </button>
              )
            })}
          </div>
        </>
      )}

      <label style={label} htmlFor="cfg-blob">Paste config — the code from install.sh</label>
      <textarea id="cfg-blob" style={{ ...input, minHeight: 64, resize: 'vertical', fontFamily: 'monospace', fontSize: 13 }}
        value={blob} onChange={(e) => { setBlob(e.target.value); setErr('') }} placeholder="g2sidian:…" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      <button style={{ ...btn, marginTop: 10 }} onClick={applyBlob} disabled={busy}>{busy ? 'Connecting…' : 'Paste config & connect'}</button>

      <div style={divider}><div style={rule} /> or enter manually <div style={rule} /></div>
      <label style={label} htmlFor="cfg-url">Backend URL (your Tailscale HTTPS address)</label>
      <input id="cfg-url" type="url" inputMode="url" style={input} value={base} onChange={(e) => { setBase(e.target.value); setErr('') }} placeholder="your-host.tailnet.ts.net:8445" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      <label style={label} htmlFor="cfg-token">Access token (your G2SIDIAN_TOKEN)</label>
      <input id="cfg-token" type="password" style={input} value={token} onChange={(e) => { setToken(e.target.value); setErr('') }} placeholder="paste your token" autoCapitalize="off" autoCorrect="off" spellCheck={false} />

      <label style={label} htmlFor="cfg-keypath">OpenAI key file (optional) — for voice capture</label>
      <input id="cfg-keypath" style={input} value={keyPath} onChange={(e) => { setKeyPath(e.target.value); setErr('') }} placeholder="e.g. ~/.config/openai/key" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      <p style={{ color: '#5f7a6b', fontSize: 12, marginTop: 6 }}>The key stays on your backend — only the file PATH is sent. Auto-found in ~/.env, ~/.bashrc, ~/.zshrc, etc.; set a path only if yours lives elsewhere. Without a key, type notes on the phone.</p>

      {err && <p style={{ color: '#ff8a8a', fontSize: 13 }}>{err}</p>}
      <button style={btn} onClick={save} disabled={busy}>{busy ? 'Connecting…' : 'Save & connect'}</button>
    </div>
  )
}
