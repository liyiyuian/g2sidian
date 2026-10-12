# Gbsidian — Setup

View (and voice-capture into) your **Obsidian** vaults on your Even G2 glasses. Your notes never
leave your machine — the glasses talk to a tiny backend on your computer over **your Tailscale
network** (token-required, loopback-bound, tailnet-only HTTPS).

## What you need
- The computer that holds your Obsidian vault(s), with **Python 3.10+** and **Tailscale**
  (installed + logged in).
- The **Even** phone app + your G2 glasses — with **Tailscale on the phone too**, signed into the
  **same tailnet** (the glasses reach your backend *through* the phone, so the phone must be on the tailnet).
- (Optional) an **OpenAI API key** for voice capture (Whisper). Without it you type notes on the phone.

## 1. Set up the backend (one command)
```bash
git clone https://github.com/liyiyuian/g2sidian && cd g2sidian && ./install.sh
```
This single command:
- auto-discovers your Obsidian vaults (any folder containing `.obsidian/`) and generates an access token,
- writes `~/.config/g2sidian.env` (chmod 600), installs a `systemd --user` service, and exposes it
  tailnet-only on **`:8445`** (`tailscale serve --https=8445`) → `https://<host>.<tailnet>.ts.net:8445`,
  which the app's `*.ts.net:8445` whitelist entry matches, and
- prints a `g2sidian:…` **config line** (and a QR) for the phone.

> It asks once for an optional OpenAI key (Enter to skip) and uses `sudo` once for `tailscale serve`.
> Serving on `:8445` lets Gbsidian coexist with other Tailscale-served apps (one app owns the `:443`
> root per machine). Re-run any time — it reuses your token.

## 2. Install the glasses app
Install **Gbsidian** from [hub.evenrealities.com](https://hub.evenrealities.com) — it's **one public
build that works with any backend** (no rebuild, nothing baked). On the phone: **Me → Apps → Install**.

## 3. Connect & pick your vault
Open **Gbsidian** on the phone → **Setup** → **Paste config** → paste the line `install.sh` printed
→ **Save**. Once connected, a **Vault** picker appears — **tap the vault** you want the glasses to open
into (switch any time, from the phone). It persists across reinstalls. Status shows
"● Connected — N vaults · voice on/off".

## 4. Use it (3 gestures: tap / double-tap / swipe)
The glasses open straight into your chosen vault's folder tree.
- **Browser** → tap a folder to descend, a note to open. Action rows: **» Quick capture**,
  **» Search this vault**, and (at the vault root) **» Jump / find**. Double-tap = up a folder
  (or exit the app at the root); swipe = move the cursor.
- **Jump / find** → **Read today** (opens today's daily note), **Recently modified**, **Bookmarks**
  (from `.obsidian/bookmarks.json`), **Tasks due**, **Switch vault**. Tap to go, double-tap = back.
- **Reader** → swipe to scroll. **Tap = menu**: follow a **[[wikilink]]**, jump to a **heading**, or
  **add to this note** (on a plain note, tap goes straight to add). Double-tap walks back your link
  trail, then out. `tasks` / `dataview` blocks (incl. `dataviewjs` dashboards) render live; `#tags`
  show up top; `![[embeds]]` expand inline.
- **Capture** → **swipe = choose where it lands** (this note / daily / inbox), then speak or type, and
  tap when done. On the preview, **swipe scrolls** so you can see all of it; tap = save, double-tap =
  redo. If the note changed in Obsidian mid-capture, tap once more to **add it anyway**. After saving,
  tap = open the note you just wrote to.
- **Search** → speak then tap, or type on the phone; in results, tap = open, double-tap = back.

---

## Advanced / manual

**Backend only** (no glasses build — e.g. a headless box): `curl -fsSL
https://raw.githubusercontent.com/liyiyuian/g2sidian/main/install.sh | bash` downloads the three backend
files (`g2sidian_api.py`, `md_flatten.py`, `vault_query.py`), sets up the service, and serves it.

**Fully manual** — create `~/.config/g2sidian.env` (chmod 600):
```
G2SIDIAN_TOKEN=<a long random string>
G2SIDIAN_BIND=127.0.0.1
G2SIDIAN_API_PORT=8793
G2SIDIAN_VAULTS=[{"name":"Work","path":"~/Documents/Work"},{"name":"Personal","path":"~/Documents/personal"}]
G2SIDIAN_CAPTURE_MODE=daily          # voice quick-capture target: daily | inbox
# G2SIDIAN_DAILY_FOLDER=Journal      # optional; if unset, auto-detected from .obsidian/daily-notes.json
# G2SIDIAN_DAILY_FORMAT=%Y-%m-%d     # optional; if unset, auto-detected from daily-notes.json (else this)
# G2SIDIAN_CAPTURE_VAULT=Personal    # which vault quick-capture writes to (default: first)
# G2SIDIAN_INBOX_PATH=Inbox.md       # used when G2SIDIAN_CAPTURE_MODE=inbox
# OPENAI_API_KEY=sk-...              # enables voice capture (or G2SIDIAN_OPENAI_KEY_PATH=~/path/to/keyfile)
```
then `python3 g2sidian_api.py` (or run as a service) and `sudo tailscale serve --bg 8793` (default `:443`).
Build the app from source (optional — the published Hub build already works with any backend):
`cp glasses/app.json.example glasses/app.json && cd glasses && npm install && bash build.sh` — keeps the
`*.ts.net` whitelist, runs the URL-allowlist guard, and packs `Gbsidian-<ver>.ehpk`.

Verify the backend: `curl -s localhost:8793/api/health` → `{"ok":true,...}`.

## Notes & safety
- The backend reads/writes your notes — it is **token-required + loopback + tailnet-only**. Never bind
  `0.0.0.0`, never share the token, never commit `~/.config/g2sidian.env`.
- Writes are **append-only** and atomic (temp+rename), with an mtime conflict check and an out-of-vault
  backup under `~/.local/state/g2sidian/backups/`. If a note is open in Obsidian, an appended line may
  not show until you switch notes — avoid appending to a note you're actively editing with unsaved changes.
