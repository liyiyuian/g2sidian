# Gbsidian

**Your Obsidian vault on your glasses — self-hosted, private, hands-free.**

View and voice-capture your [Obsidian](https://obsidian.md) notes on
[Even Realities G2](https://www.evenrealities.com/) smart glasses. A tiny backend runs on **your own
computer**, reads your vault files directly, and is reachable **only over your own Tailscale network** —
no central server, no accounts, no analytics. Your notes never leave your machine.

<p align="center">
  <img src="store-assets/screenshots/demo.gif" width="500" alt="Gbsidian demo — browser, reader, tasks, voice capture">
</p>

## What it looks like

| Open straight into your vault | Read a note, flattened to clean lines |
|:---:|:---:|
| ![Browser](store-assets/screenshots/1-browser.png) | ![Reader](store-assets/screenshots/2-reader.png) |
| **Tasks & Dataview rendered live** | **Hands-free voice capture** |
| ![Tasks](store-assets/screenshots/3-tasks.png) | ![Capture](store-assets/screenshots/4-capture.png) |

<sub>Screenshots use a demo vault — not real notes.</sub>

## Features

- **Land where you live** — the glasses open straight into your chosen vault. Browse the folder tree,
  or **Jump / find** → open **today's daily note**, **recently modified**, your **Bookmarks**
  (mirrored from `.obsidian/bookmarks.json`), or **what's due** — no phone typing.
- **Read like a note** — notes render to clean lines (wikilinks, callouts, tasks, tables, headings,
  `#tags` shown up top), and **embeds (`![[note]]`) expand inline**. Tap to **follow a `[[wikilink]]`**
  or **jump by heading**; double-tap walks back the trail.
- **Live Tasks & Dataview** — `tasks` and `dataview` (LIST/TASK) query blocks render as live results,
  and the **Tasks due** hub lists overdue/today across the whole vault. Common **`dataviewjs` task
  dashboards** render too (the embedded query is extracted; no JavaScript is executed). Anything
  outside the supported subset shows a placeholder rather than a wrong answer.
- **Search** — full text, filename, **alias**, or **`#tag`** (finds YAML-only tags a text scan misses).
- **Voice capture** — speak (or type on the phone) into today's daily note, an inbox, or the note
  you're reading — **swipe to choose the destination**, scroll the preview to check, then open what you
  captured. Note open in Obsidian? One tap to **add it anyway**. No voice key? Type on the phone.
- **Private by design** — loopback-bound, token-required, tailnet-only. The developer runs no server
  and collects nothing.

3 gestures, reassigned per screen: **tap** = open / choose · **double-tap** = back · **swipe** = move / scroll.

## Quick start

You self-host Gbsidian — your notes stay on your machine. You need **Python 3.10+** and **Tailscale**
on that computer, plus **Tailscale on your phone** (same tailnet — the glasses reach the backend
through the phone). No build tools required — the app is one published build.

1. **Backend** — clone and run the installer (sets up a `systemd --user` service and serves it
   tailnet-only over HTTPS on `:8445`, which coexists with other Tailscale-served apps):
   ```bash
   git clone https://github.com/liyiyuian/g2sidian && cd g2sidian && ./install.sh
   ```
   It auto-discovers your Obsidian vaults, generates a token, and prints a `g2sidian:…` config line
   (and a QR) for the phone.
2. **App** — install **Gbsidian** from [hub.evenrealities.com](https://hub.evenrealities.com). One
   public build works with any backend — nothing to rebuild.
3. **Connect** — open **Gbsidian → Setup → Paste config**, paste the line, and pick a vault.

More detail (and a from-source build path): **[SETUP.md](SETUP.md)**.

> **Self-hosted, one build for all:** the app ships a wildcard whitelist (`*.ts.net` **and**
> `*.ts.net:8445`), so a single published build connects to *your* backend (entered in Setup) without
> baking anyone's address in. `install.sh` serves on `:8445` (covered by the `*.ts.net:8445` entry) so
> it coexists with other Tailscale-served apps; the plain `*.ts.net` entry also covers a `:443` backend.

## How it works

- **Backend** (`g2sidian_api.py` + `md_flatten.py` + `vault_query.py`) — Python **stdlib** HTTP control
  plane on your computer. Reads/writes the vault `.md` files directly (no Obsidian process or plugin
  needed), exposes a token-auth JSON API on `127.0.0.1:8793`, published tailnet-only via `tailscale
  serve`. Writes are append-only, atomic, conflict-checked, and byte-preserving (frontmatter untouched).
- **Glasses app** (`glasses/`) — Vite + React + [`even-toolkit`](https://www.npmjs.com/package/even-toolkit)
  Even Hub plugin. Per-user backend URL + token entered once in a phone Setup screen; no secrets baked in.

## Privacy & security

The backend reads and writes your notes — treat it as a sensitive surface. It **requires a token**,
binds **loopback only**, and is reachable **only over your tailnet**. Never bind `0.0.0.0`, never share
the token, never commit `~/.config/g2sidian.env`. Voice transcription is optional and only used if you
add your own OpenAI Whisper key; if enabled, dictated audio is sent to OpenAI to transcribe (see
[store-assets/privacy.txt](store-assets/privacy.txt)).

## License

[MIT](LICENSE).
