// Per-user connection config. Stored in the WebView's localStorage (fast, sync) AND mirrored to
// the Even app's persistent storage via the SDK so it survives reinstalls/updates. Nothing is
// baked into the shipped app. The build-time env fallback is used ONLY for a personal build.
import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'

const LS_URL = 'g2sidian.baseUrl'
const LS_TOKEN = 'g2sidian.token'
const LS_VAULT = 'g2sidian.vault'               // which vault the glasses open into (chosen on the phone)
const LS_OPENAI_PATH = 'g2sidian.openaiKeyPath' // optional PATH on the backend to the OpenAI key FILE (never the key itself)
const PERSIST_KEY = 'g2sidian.config'           // single key in the phone app's persistent store
const PERSONAL = !!import.meta.env.VITE_PERSONAL // personal build only

export interface Config { base: string; token: string }

// The active vault is chosen on the PHONE (Setup) — the glasses open straight into it.
export function getVault(): string { return localStorage.getItem(LS_VAULT) || '' }
export function setVault(name: string) { localStorage.setItem(LS_VAULT, name); persist() }

// Optional PATH (on the backend) to a file holding the OpenAI key. The key itself never touches the
// phone — the backend reads it from this path (it also auto-discovers ~/.env, ~/.bashrc, etc.).
export function getOpenaiKeyPath(): string { return localStorage.getItem(LS_OPENAI_PATH) || '' }
export function setOpenaiKeyPath(p: string) { localStorage.setItem(LS_OPENAI_PATH, p.trim()); persist() }

export function getConfig(): Config {
  const envBase = PERSONAL ? import.meta.env.VITE_G2SIDIAN_API : ''
  const envToken = PERSONAL ? import.meta.env.VITE_G2SIDIAN_TOKEN : ''
  const base = (localStorage.getItem(LS_URL) || envBase || '').replace(/\/+$/, '')
  const token = localStorage.getItem(LS_TOKEN) || envToken || ''
  return { base, token }
}

function persist() {
  const c = getConfig()
  waitForEvenAppBridge()
    .then((b) => b.setLocalStorage(PERSIST_KEY, JSON.stringify({ base: c.base, token: c.token, vault: getVault(), openaiKeyPath: getOpenaiKeyPath() })))
    .catch(() => {})
}

export function setConfig(c: Config) {
  localStorage.setItem(LS_URL, c.base.trim().replace(/\/+$/, ''))
  localStorage.setItem(LS_TOKEN, c.token.trim())
  persist()
}

export function isConfigured(): boolean { const c = getConfig(); return !!c.base && !!c.token }

// Seed localStorage from the phone app's persistent store at boot, so a fresh install/update
// reconnects automatically without re-entering anything. Call before rendering.
export async function loadPersistedConfig(): Promise<void> {
  if (isConfigured()) return
  try {
    const b = await Promise.race([
      waitForEvenAppBridge(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500)),
    ])
    if (!b) return
    const raw = await b.getLocalStorage(PERSIST_KEY)
    if (raw) {
      const c = JSON.parse(raw)
      if (c && c.base && c.token) {
        localStorage.setItem(LS_URL, c.base); localStorage.setItem(LS_TOKEN, c.token)
        if (c.vault) localStorage.setItem(LS_VAULT, c.vault)
        if (c.openaiKeyPath) localStorage.setItem(LS_OPENAI_PATH, c.openaiKeyPath)
      }
    }
  } catch { /* no bridge / nothing stored -> Setup screen */ }
}
