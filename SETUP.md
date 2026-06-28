# G2sidian — Setup

View (and voice-capture into) your **Obsidian** vaults on your Even G2 glasses. Your notes never
leave your machine — the glasses talk to a tiny backend on your computer over **your Tailscale
network** (token-required, loopback-bound, tailnet-only HTTPS).

## What you need
- The computer that holds your Obsidian vault(s), with **Python 3.10+** and **Tailscale** (logged in).
- The **Even** phone app + your G2 glasses.
- (Optional) an **OpenAI API key** for voice capture (Whisper). Without it you type notes on the phone.

## 1. Stand up the backend (one command)
```bash
curl -fsSL https://raw.githubusercontent.com/liyiyuian/g2sidian/main/install.sh | bash
```
It auto-discovers your Obsidian vaults (any folder containing `.obsidian/`), generates a token,
writes `~/.config/g2sidian.env`, installs a `systemd --user` service, exposes it on your tailnet at
`https://<host>.<tailnet>.ts.net:8445`, and prints a **paste-config** line (and a QR) for the app.

> Running from this repo instead of curl:
> `G2SIDIAN_SRC=$(pwd) ./install.sh`  (copies `g2sidian_api.py` + `md_flatten.py` from here)

**Manual alternative** — create `~/.config/g2sidian.env` (chmod 600):
```
G2SIDIAN_TOKEN=<a long random string>
G2SIDIAN_BIND=127.0.0.1
G2SIDIAN_API_PORT=8793
G2SIDIAN_VAULTS=[{"name":"Work","path":"~/Documents/Work"},{"name":"Personal","path":"~/Documents/personal"}]
G2SIDIAN_CAPTURE_MODE=daily          # voice quick-capture target: daily | inbox
G2SIDIAN_DAILY_FORMAT=%Y-%m-%d
# G2SIDIAN_CAPTURE_VAULT=Personal    # which vault quick-capture writes to (default: first)
# G2SIDIAN_INBOX_PATH=Inbox.md       # used when G2SIDIAN_CAPTURE_MODE=inbox
# OPENAI_API_KEY=sk-...              # enables voice capture (or G2SIDIAN_OPENAI_KEY_PATH=~/path/to/keyfile)
```
then run it as a service and expose it:
```bash
python3 g2sidian_api.py                       # foreground test
sudo tailscale serve --bg --https=8445 8793   # tailnet HTTPS mount
```

Verify (replace TOKEN):
```bash
curl -s localhost:8793/api/health                                   # {"ok":true,...}
curl -s -H "Authorization: Bearer TOKEN" localhost:8793/api/vaults  # your vault list
```

## 2. Install the glasses app
- Sideload for testing: `cd glasses && npm install && npm run dev`, then
  `npx @evenrealities/evenhub-cli@latest qr --url http://<lan-ip>:5173` → in the Even app tap
  **Scan QR** (developer section). Or install the packed **`glasses/G2sidian-0.2.2.ehpk`** as a
  Private build at hub.evenrealities.com → phone **Me → Apps → Private builds → Install**.

## 3. Connect & pick your vault
Open **G2sidian** on the phone → **Setup** → **Paste config** → paste the line install.sh printed
(or enter the Backend URL `https://<host>.<tailnet>.ts.net:8445` + token by hand) → **Save**. Once
connected, a **Vault** picker appears — **tap the vault you want the glasses to open into** (you can
switch any time, here on the phone). Everything persists across reinstalls. The status line shows
"● Connected — N vaults · voice on/off".

## 4. Use it (3 gestures: tap / double-tap / swipe)
The glasses open straight into your chosen vault's folder tree.
- **Browser** → tap a folder to descend, a note to open; row 0 = 🎤 **Quick capture** (speak/type →
  today's daily note), row 1 = 🔍 **Search**; double-tap = up a folder; swipe = scroll.
- **Reader** → swipe to scroll; **tap = voice-append to this note**; double-tap = back.
- **Capture/Search** → speak then tap (or type on the phone); double-tap = cancel/back.
- At the vault's **root** folder, double-tap = exit the app. (Switch vaults from the phone Setup.)

## Notes & safety
- The backend reads/writes your notes — it is **token-required + loopback + tailnet-only**. Never
  bind `0.0.0.0`, never share the token, never commit `~/.config/g2sidian.env`.
- v1 writes are **append-only** and atomic (temp+rename), with an mtime conflict check and an
  out-of-vault backup under `~/.local/state/g2sidian/backups/`. If you have the note open in
  Obsidian, the appended line may not show until you switch notes (Obsidian doesn't always reload
  an open file) — and to be safe, don't append to a note you're actively editing with unsaved changes.
