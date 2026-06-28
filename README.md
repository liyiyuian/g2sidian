# G2sidian

View — and hands-free voice-capture into — your **Obsidian** notes on **Even Realities G2** smart
glasses. Your vaults stay on your own machine; the glasses reach a tiny local backend over your
**Tailscale** network (token-required, tailnet-only).

- **Browse** every vault's folder tree, **search** by filename/tag/full-text, and **read** notes
  rendered to clean lines (Obsidian markdown flattened: wikilinks, callouts, tasks, tables…).
- **Tasks & Dataview** — `tasks` and `dataview` (LIST/TASK) query blocks are evaluated server-side
  and rendered as live results (e.g. a "what's due today" view). Common **task dashboards built with
  `dataviewjs`** render too (the embedded Tasks query is extracted — no JavaScript is executed);
  anything outside the supported subset shows a placeholder.
- **Quick-capture** a thought by voice straight into today's daily note (or an inbox).
- **Append** to the note you're reading by voice — or type on the phone when you'd rather.

Pick which vault to open on the phone. 3 gestures: **tap** = open / capture, **double-tap** = back, **swipe** = scroll.

## How it works
- **Backend** (`g2sidian_api.py` + `md_flatten.py` + `vault_query.py`) — Python **stdlib** HTTP
  control plane on your computer. Reads/writes the vault `.md` files directly (no Obsidian process or
  plugin needed), exposes a token-auth JSON API on `127.0.0.1:8793`, published tailnet-only via
  `tailscale serve`. Writes are append-only, atomic, conflict-checked, and byte-preserving.
- **Glasses app** (`glasses/`) — Vite + React + `even-toolkit` Even Hub plugin. Per-user backend
  URL + token entered once in a phone Setup screen; no secrets baked into the build.

## Run your own backend
Your notes never leave your machine — you host the backend yourself, reachable only over your own
Tailscale network. Needs **Python 3.10+** and **Tailscale** (logged in).

1. **Backend:** clone this repo, then run the installer (it auto-discovers your Obsidian vaults,
   generates a token, installs a `systemd --user` service, and serves it over your tailnet):
   ```bash
   cd g2sidian && G2SIDIAN_SRC=$(pwd) ./install.sh
   ```
   It prints a `g2sidian:…` config line (and a QR) for the phone. Full details + the manual path:
   **[SETUP.md](SETUP.md)**.
2. **Build the glasses app** — Even enforces an *exact-origin* network whitelist, so put **your**
   backend's address in the manifest:
   ```bash
   cp glasses/app.json.example glasses/app.json
   # edit glasses/app.json → permissions[network].whitelist to your Tailscale HTTPS origin,
   #   e.g. "https://<host>.<tailnet>.ts.net:8445"  (exact origin incl. port; wildcards are rejected)
   cd glasses && npm install && npm run build
   npx @evenrealities/evenhub-cli@latest pack app.json dist -o G2sidian.ehpk
   ```
3. **Install** `G2sidian.ehpk` via [hub.evenrealities.com](https://hub.evenrealities.com) (Private
   build) or QR-sideload, then open the app → **Setup** → paste the config line → pick a vault.

## Security
The backend reads and writes your notes — treat it as a sensitive surface. It **requires a token**,
binds **loopback only**, and is reachable **only over your tailnet**. Never bind `0.0.0.0`, never
share the token, never commit `~/.config/g2sidian.env`.

## License
MIT — see [LICENSE](LICENSE).
