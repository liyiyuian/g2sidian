#!/usr/bin/env python3
"""JSON control-plane for Gbsidian — the Even G2 glasses app that views (and lightly edits)
the user's Obsidian vaults. Reads/writes the vault folders DIRECTLY off disk (no Obsidian /
no plugin needed); stdlib only.

⚠ This runs on the user's machine and reads/writes their notes. Treat it as an RCE/file
surface: bind 127.0.0.1, MANDATORY token, expose tailnet-only via `tailscale serve`. Every
note path is jailed to its vault root (realpath, no `../`/symlink escape).

Endpoints (token required on all except /api/health):
  GET  /api/health                                  -> {ok, voice, vaults:[name...]}
  GET  /api/vaults                                  -> {vaults:[{name}]}
  GET  /api/list?vault=&path=                       -> {vault, path, parent, entries:[...]}
  GET  /api/note?vault=&path=                       -> {vault, path, title, tags, mtime, lines:[...]}
  GET  /api/search?vault=&q=&limit=                 -> {q, results:[{path,title,score,snippet,mtime}]}
  GET  /api/capture/target[?vault=&mode=]           -> {vault, path, exists, label}
  POST /api/transcribe        (raw WAV body)        -> {text, seconds, cost}
  POST /api/append   {vault, path, text, base_mtime}-> {ok, path, mtime}  (append a line, atomic+CAS)
  POST /api/capture  {text, vault?, mode?}          -> {ok, vault, path, mtime, created}

Run:  python g2sidian_api.py
Env (see ~/.config/g2sidian.env):
  G2SIDIAN_TOKEN          (REQUIRED) bearer token
  G2SIDIAN_VAULTS         JSON: [{"name":"Work","path":"~/Documents/Work"}, ...]
  G2SIDIAN_API_PORT       default 8793
  G2SIDIAN_BIND           default tailscale ip, else 127.0.0.1
  G2SIDIAN_CAPTURE_VAULT  vault name for voice quick-capture (default: first vault)
  G2SIDIAN_CAPTURE_MODE   daily|inbox (default daily)
  G2SIDIAN_INBOX_PATH     vault-relative inbox note (default Inbox.md)
  G2SIDIAN_DAILY_FOLDER   vault-relative folder for daily notes (default "": vault root)
  G2SIDIAN_DAILY_FORMAT   strftime for the daily-note name (default %Y-%m-%d)
"""
import hmac
import json
import os
import re
import subprocess
import tempfile
import threading
import time
import urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import md_flatten
import vault_query

TOKEN = os.environ.get("G2SIDIAN_TOKEN", "")
BACKUP_DIR = os.path.expanduser("~/.local/state/g2sidian/backups")
# serialize ALL writes — ThreadingHTTPServer runs requests concurrently, so two near-simultaneous
# appends/captures would otherwise read the same base and the last os.replace would silently win.
_WRITE_LOCK = threading.Lock()
MAX_JSON = 256 * 1024          # cap a JSON request body (anti-OOM)
MAX_AUDIO = 26 * 1024 * 1024   # cap a transcribe upload (~Whisper's 25 MB limit)

# dirs/files never listed or searched
_SKIP_DIRS = {".obsidian", ".trash", ".git", ".stfolder", ".stversions", "node_modules"}


def _expand(p):
    return os.path.realpath(os.path.expanduser(p))


def load_vaults():
    """Parse G2SIDIAN_VAULTS into an ordered [{name, root}] keyed by absolute path.
    Names must be unique (the 'personal'/'Personal' folders collide case-insensitively, so
    the user gives them distinct display names in config)."""
    raw = os.environ.get("G2SIDIAN_VAULTS", "").strip()
    out = []
    if not raw:
        return out
    try:
        items = json.loads(raw)
    except json.JSONDecodeError:
        return out
    seen = set()
    for it in items:
        name = str(it.get("name", "")).strip()
        root = _expand(it.get("path", ""))
        if name and name not in seen and os.path.isdir(root):
            seen.add(name)
            out.append({"name": name, "root": root})
    return out


VAULTS = load_vaults()


def vault_root(name):
    for v in VAULTS:
        if v["name"] == name:
            return v["root"]
    return None


def attachment_folder(root):
    """Read .obsidian/app.json's attachmentFolderPath so we don't list attachments as notes.
    Returns a vault-relative dir name (best-effort, '' if none/at-root)."""
    try:
        with open(os.path.join(root, ".obsidian", "app.json"), encoding="utf-8") as f:
            af = json.load(f).get("attachmentFolderPath", "")
        af = (af or "").strip().lstrip("./").rstrip("/")
        # only honor a folder-style value (not "./" same-folder or a "" default)
        return af if af and not af.startswith(".") else ""
    except (OSError, json.JSONDecodeError, ValueError):
        return ""


def safe_join(root, rel):
    """Jail `rel` under `root`. Returns the realpath or raises ValueError on escape."""
    rel = (rel or "").lstrip("/")
    full = os.path.realpath(os.path.join(root, rel))
    if full == root or full.startswith(root + os.sep):
        return full
    raise ValueError("path escapes vault")


def _is_note(fn):
    return fn.endswith(".md") and not fn.endswith(".excalidraw.md")


# --- listing ---------------------------------------------------------------

def list_dir(root, rel):
    full = safe_join(root, rel)
    if not os.path.isdir(full):
        raise FileNotFoundError(rel)
    af = attachment_folder(root)
    entries = []
    for name in os.listdir(full):
        if name.startswith("."):
            continue
        p = os.path.join(full, name)
        try:
            st = os.stat(p)
        except OSError:
            continue
        if os.path.isdir(p):
            if name in _SKIP_DIRS:
                continue
            child_rel = os.path.relpath(p, root)
            if af and child_rel == af:
                continue
            entries.append({"name": name, "type": "dir", "mtime": st.st_mtime_ns})
        elif _is_note(name):
            entries.append({"name": name[:-3], "file": name, "type": "note",
                            "mtime": st.st_mtime_ns, "size": st.st_size})
    # dirs first, then notes; each alphabetical (case-insensitive)
    entries.sort(key=lambda e: (e["type"] != "dir", e["name"].lower()))
    parent = "" if not rel.strip("/") else os.path.dirname(rel.strip("/"))
    return {"path": rel.strip("/"), "parent": parent, "entries": entries}


# --- read a note -----------------------------------------------------------

def read_note(root, rel):
    full = safe_join(root, rel)
    if not (os.path.isfile(full) and _is_note(os.path.basename(full))):
        raise FileNotFoundError(rel)
    with open(full, encoding="utf-8", errors="replace") as f:
        text = f.read()
    # render ```tasks / ```dataview blocks against the whole vault (subset; placeholder if unsupported)
    data = md_flatten.flatten(text, query_runner=lambda kind, q: vault_query.run(root, kind, q))
    st = os.stat(full)
    return {
        "path": os.path.relpath(full, root),
        "title": data["title"] or os.path.basename(full)[:-3],
        "tags": data["tags"],
        "aliases": data["aliases"],
        "lines": data["lines"],
        # CAS token as a STRING: st_mtime_ns (~1.8e18) exceeds JS Number.MAX_SAFE_INTEGER, so a
        # bare JSON number would be quantized on the phone and never match on round-trip.
        "mtime": str(st.st_mtime_ns),
        "size": st.st_size,
    }


# --- search ----------------------------------------------------------------

def _snippet(content, terms, width=90):
    cl = content.lower()
    idx = min((cl.find(t) for t in terms if cl.find(t) >= 0), default=-1)
    if idx < 0:
        idx = 0
    start = max(0, idx - 30)
    chunk = content[start:start + width]
    chunk = re.sub(r"\s+", " ", chunk).strip()
    return ("…" if start > 0 else "") + chunk


def search(root, q, limit=50):
    q = (q or "").strip().lower()
    if not q:
        return []
    terms = q.split()
    af = attachment_folder(root)
    results = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in _SKIP_DIRS
                       and (not af or os.path.relpath(os.path.join(dirpath, d), root) != af)]
        for fn in filenames:
            if not _is_note(fn):
                continue
            full = os.path.join(dirpath, fn)
            name = fn[:-3]
            namel = name.lower()
            score = 0
            if q in namel:
                score += 100
            score += 20 * sum(1 for t in terms if t in namel)
            try:
                with open(full, encoding="utf-8", errors="replace") as f:
                    content = f.read()
            except OSError:
                continue
            cl = content.lower()
            if q in cl:
                score += 5
            score += 2 * sum(1 for t in terms if t in cl)
            if score <= 0:
                continue
            try:
                st = os.stat(full)
            except OSError:
                continue
            results.append({
                "path": os.path.relpath(full, root),
                "title": name,
                "score": score,
                "snippet": _snippet(content, terms),
                "mtime": st.st_mtime_ns,
            })
    results.sort(key=lambda r: (-r["score"], -r["mtime"]))
    return results[:limit]


# --- safe writes (atomic temp+rename, mtime compare-and-swap, out-of-vault backup) ----

class Conflict(Exception):
    pass


def _backup(root, full):
    """Copy the current file to ~/.local/state/g2sidian/backups/<vault-basename>/<rel>.<ts> BEFORE
    overwriting. Best-effort recovery net (the vaults aren't git repos)."""
    if not os.path.isfile(full):
        return
    try:
        rel = os.path.relpath(full, root)
        dest_dir = os.path.join(BACKUP_DIR, os.path.basename(root), os.path.dirname(rel))
        os.makedirs(dest_dir, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        with open(full, "rb") as src:
            data = src.read()
        with open(os.path.join(dest_dir, os.path.basename(rel) + "." + ts + ".bak"), "wb") as out:
            out.write(data)
    except OSError:
        pass  # never block a write on backup failure


def _cas_check(full, base_mtime):
    """Raise Conflict unless `full`'s current mtime matches base_mtime. Compare as STRINGS (the
    token crosses JS as a string). base_mtime None = skip (caller holds the lock / create path)."""
    if base_mtime is None:
        return
    cur = str(os.stat(full).st_mtime_ns) if os.path.exists(full) else None
    if cur != str(base_mtime):
        raise Conflict("note changed on disk since you opened it")


def atomic_replace(root, full, new_bytes, base_mtime=None):
    """Write new_bytes to `full` atomically. If base_mtime is given and the file changed since
    (or vanished/appeared), raise Conflict — guards a lost update against Obsidian editing it.
    Caller must hold _WRITE_LOCK; the re-check here right before os.replace shrinks the TOCTOU."""
    _cas_check(full, base_mtime)  # re-check immediately before writing
    _backup(root, full)
    d = os.path.dirname(full)
    os.makedirs(d, exist_ok=True)
    # dotfile temp + non-.md suffix so Obsidian's watcher never indexes it
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".g2sidian-", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(new_bytes)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, full)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return str(os.stat(full).st_mtime_ns)


def append_to_note(root, rel, addition, base_mtime=None, create=False):
    """Append `addition` as its own line at EOF, preserving everything above BYTE-FOR-BYTE
    (frontmatter and any non-UTF-8 bytes included — we never decode the existing content; only
    the new line is encoded). Serialized under _WRITE_LOCK so concurrent appends can't lose data.
    Returns (rel, new_mtime, created)."""
    full = safe_join(root, rel)
    with _WRITE_LOCK:
        created = False
        if os.path.isfile(full):
            with open(full, "rb") as f:
                existing = f.read()
        elif create:
            existing = b""
            created = True
            base_mtime = None
        else:
            raise FileNotFoundError(rel)
        nl = b"" if (not existing or existing.endswith(b"\n")) else b"\n"
        new_bytes = existing + nl + addition.rstrip("\n").encode("utf-8") + b"\n"
        mtime = atomic_replace(root, full, new_bytes, base_mtime)
    return os.path.relpath(full, root), mtime, created


# --- voice quick-capture target resolution ---------------------------------

def capture_config(vault_override=None, mode_override=None):
    name = vault_override or os.environ.get("G2SIDIAN_CAPTURE_VAULT", "") or (VAULTS[0]["name"] if VAULTS else "")
    mode = (mode_override or os.environ.get("G2SIDIAN_CAPTURE_MODE", "daily")).lower()
    return name, ("inbox" if mode == "inbox" else "daily")


def capture_target(vault_override=None, mode_override=None):
    """Resolve the quick-capture note (vault name, vault-relative path, exists, label)."""
    name, mode = capture_config(vault_override, mode_override)
    root = vault_root(name)
    if not root:
        raise FileNotFoundError("capture vault not configured")
    if mode == "inbox":
        rel = os.environ.get("G2SIDIAN_INBOX_PATH", "Inbox.md").strip().lstrip("/")
        if not rel.endswith(".md"):
            rel += ".md"
        label = "Inbox"
    else:
        folder = os.environ.get("G2SIDIAN_DAILY_FOLDER", "").strip().strip("/")
        fmt = os.environ.get("G2SIDIAN_DAILY_FORMAT", "%Y-%m-%d")
        fname = datetime.now().strftime(fmt) + ".md"
        rel = os.path.join(folder, fname) if folder else fname
        label = "Daily note " + datetime.now().strftime(fmt)
    full = safe_join(root, rel)  # validate jail now
    return {"vault": name, "path": os.path.relpath(full, root), "exists": os.path.isfile(full), "label": label, "mode": mode}


# --- transcription (OpenAI Whisper) — reused from tmuxor's conductor_api ----

WHISPER_USD_PER_MIN = 0.006


def wav_seconds(audio):
    try:
        rate = int.from_bytes(audio[24:28], "little")
        data = int.from_bytes(audio[40:44], "little")
        if rate and data:
            return data / (rate * 2)
    except Exception:
        pass
    return 0.0


def _openai_key_files(path_override=None):
    # Searched in order: the phone-supplied path (authed only) -> a server env var -> ~/.env and the
    # common shell rc/profile files (where an `export OPENAI_API_KEY=...` usually lives) -> dedicated key files.
    return [p for p in (path_override, os.environ.get("G2SIDIAN_OPENAI_KEY_PATH"),
                        "~/.env", "~/.bashrc", "~/.bash_profile", "~/.profile",
                        "~/.zshrc", "~/.zprofile", "~/.bash_aliases",
                        "~/.openai", "~/.config/openai/key", "~/.config/openai.env") if p]


def openai_key_checked(path_override=None):
    return ["OPENAI_API_KEY env var"] + [os.path.expanduser(p) for p in _openai_key_files(path_override)]


def openai_key(path_override=None):
    """Find the OpenAI key on this machine WITHOUT it ever touching the phone. Excludes
    Anthropic keys (sk-ant-)."""
    k = os.environ.get("OPENAI_API_KEY", "")
    if k.startswith("sk-") and not k.startswith("sk-ant-"):
        return k
    for p in _openai_key_files(path_override):
        try:
            with open(os.path.expanduser(p)) as f:
                txt = f.read()
        except OSError:
            continue
        m = re.search(r"OPENAI_API_KEY\s*[=:]\s*['\"]?(sk-[A-Za-z0-9_\-]{20,})", txt) \
            or re.search(r"(?<![A-Za-z0-9])(sk-(?!ant-)[A-Za-z0-9_\-]{20,})", txt)
        if m:
            return m.group(1)
    return ""


def whisper_transcribe(audio, key):
    if not key.startswith("sk-"):
        raise RuntimeError("no OpenAI API key found (set OPENAI_API_KEY, put it in ~/.env, or set a key-file path in Setup)")
    boundary = "----g2sidian-" + str(int(time.time() * 1000))
    crlf = b"\r\n"
    bb = boundary.encode()

    def field(name, value):
        return (b"--" + bb + crlf
                + ('Content-Disposition: form-data; name="%s"' % name).encode() + crlf + crlf
                + value.encode() + crlf)

    body = field("model", "whisper-1") + field("response_format", "json")
    body += (b"--" + bb + crlf
             + b'Content-Disposition: form-data; name="file"; filename="audio.wav"' + crlf
             + b"Content-Type: audio/wav" + crlf + crlf + audio + crlf
             + b"--" + bb + b"--" + crlf)
    req = urllib.request.Request(
        "https://api.openai.com/v1/audio/transcriptions", data=body,
        headers={"Authorization": "Bearer " + key,
                 "Content-Type": "multipart/form-data; boundary=" + boundary}, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode()).get("text", "").strip()


# --- HTTP ------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    timeout = 30  # slowloris guard

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("access-control-allow-origin", "*")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authed(self):
        tok = self.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        if not tok:
            tok = parse_qs(urlparse(self.path).query).get("token", [""])[0]
        return bool(TOKEN) and hmac.compare_digest(tok.encode(), TOKEN.encode())

    def _capped_len(self, limit):
        """Validated Content-Length, or None after sending a 400/413 (anti-OOM)."""
        try:
            n = int(self.headers.get("content-length", 0))
        except (TypeError, ValueError):
            self._json(400, {"error": "bad content-length"})
            return None
        if n < 0 or n > limit:
            self._json(413, {"error": "request too large"})
            return None
        return n

    def _body(self):
        """Parse a capped JSON body. On any problem sends the error response itself, returns None."""
        n = self._capped_len(MAX_JSON)
        if n is None:
            return None
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            self._json(400, {"error": "invalid JSON"})
            return None

    def log_message(self, *a):
        pass

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-methods", "GET, POST, OPTIONS")
        self.send_header("access-control-allow-headers", "authorization, content-type")
        self.send_header("content-length", "0")
        self.end_headers()

    def _vault(self, q):
        """Resolve ?vault= to a root, or None (caller 400/404s)."""
        name = q.get("vault", [""])[0]
        return name, vault_root(name)

    def do_GET(self):
        u = urlparse(self.path)
        path, q = u.path, parse_qs(u.query)
        if path == "/api/health":
            # Unauth: bare liveness only — don't disclose vault names / key presence or scan key
            # files for an unauthenticated tailnet peer. Capability details require the token.
            if not self._authed():
                return self._json(200, {"ok": True, "service": "g2sidian-api"})
            kp = q.get("keypath", [None])[0]  # phone-supplied key-file path — honored only for authed callers
            voice = bool(openai_key(kp))
            resp = {"ok": True, "service": "g2sidian-api", "voice": voice, "vaults": [v["name"] for v in VAULTS]}
            if not voice:
                resp["checked"] = openai_key_checked(kp)
            return self._json(200, resp)
        if not self._authed():
            return self._json(401, {"error": "unauthorized"})
        if path == "/api/vaults":
            return self._json(200, {"vaults": [{"name": v["name"]} for v in VAULTS]})
        if path == "/api/list":
            name, root = self._vault(q)
            if not root:
                return self._json(404, {"error": "no such vault"})
            try:
                return self._json(200, {"vault": name, **list_dir(root, q.get("path", [""])[0])})
            except FileNotFoundError:
                return self._json(404, {"error": "no such folder"})
            except ValueError:
                return self._json(400, {"error": "bad path"})
        if path == "/api/note":
            name, root = self._vault(q)
            if not root:
                return self._json(404, {"error": "no such vault"})
            try:
                return self._json(200, {"vault": name, **read_note(root, q.get("path", [""])[0])})
            except FileNotFoundError:
                return self._json(404, {"error": "no such note"})
            except ValueError:
                return self._json(400, {"error": "bad path"})
        if path == "/api/search":
            name, root = self._vault(q)
            if not root:
                return self._json(404, {"error": "no such vault"})
            limit = max(1, min(100, int(q.get("limit", ["50"])[0] or 50)))
            return self._json(200, {"vault": name, "q": q.get("q", [""])[0], "results": search(root, q.get("q", [""])[0], limit)})
        if path == "/api/capture/target":
            try:
                return self._json(200, capture_target(q.get("vault", [None])[0], q.get("mode", [None])[0]))
            except (FileNotFoundError, ValueError) as e:
                return self._json(400, {"error": str(e)})
        return self._json(404, {"error": "not_found", "path": path})

    def do_POST(self):
        u = urlparse(self.path)
        path, q = u.path, parse_qs(u.query)
        if not self._authed():
            return self._json(401, {"error": "unauthorized"})
        if path == "/api/transcribe":
            n = self._capped_len(MAX_AUDIO)
            if n is None:
                return
            audio = self.rfile.read(n)
            try:
                secs = wav_seconds(audio)
                kp = q.get("keypath", [None])[0]  # phone-supplied key-file path (already behind auth)
                return self._json(200, {
                    "text": whisper_transcribe(audio, openai_key(kp)),
                    "seconds": round(secs, 1),
                    "cost": round(secs / 60 * WHISPER_USD_PER_MIN, 4),
                })
            except Exception as e:
                return self._json(502, {"error": str(e)})
        body = self._body()
        if body is None:
            return  # _body already sent the error response
        if path == "/api/append":
            name, root = body.get("vault", ""), vault_root(body.get("vault", ""))
            if not root:
                return self._json(404, {"error": "no such vault"})
            text = (body.get("text") or "").strip()
            rel = body.get("path") or ""
            if not text:
                return self._json(400, {"error": "text required"})
            try:
                p, mtime, _ = append_to_note(root, rel, text, body.get("base_mtime"), create=False)
                return self._json(200, {"ok": True, "vault": name, "path": p, "mtime": mtime})
            except Conflict as e:
                return self._json(409, {"error": str(e)})
            except FileNotFoundError:
                return self._json(404, {"error": "no such note"})
            except ValueError:
                return self._json(400, {"error": "bad path"})
        if path == "/api/capture":
            text = (body.get("text") or "").strip()
            if not text:
                return self._json(400, {"error": "text required"})
            try:
                tgt = capture_target(body.get("vault"), body.get("mode"))
                root = vault_root(tgt["vault"])
                line = "- " + datetime.now().strftime("%H:%M") + " " + text
                p, mtime, created = append_to_note(root, tgt["path"], line, base_mtime=None, create=True)
                return self._json(200, {"ok": True, "vault": tgt["vault"], "path": p, "mtime": mtime, "created": created, "label": tgt["label"]})
            except (FileNotFoundError, ValueError) as e:
                return self._json(400, {"error": str(e)})
        return self._json(404, {"error": "not_found", "path": path})


def tailscale_ip():
    try:
        out = subprocess.run(["tailscale", "ip", "-4"], capture_output=True, text=True, timeout=5).stdout.split()
        return out[0] if out else None
    except Exception:
        return None


def main():
    port = int(os.environ.get("G2SIDIAN_API_PORT", "8793"))
    if not TOKEN:
        raise SystemExit("refusing to start without G2SIDIAN_TOKEN — this reads/writes your notes; set a token.")
    if not VAULTS:
        print("WARNING: no vaults configured (set G2SIDIAN_VAULTS) — /api/list and /api/note will 404.")
    bind = os.environ.get("G2SIDIAN_BIND") or tailscale_ip() or "127.0.0.1"
    print(f"g2sidian-api on http://{bind}:{port}  (token required)  vaults: {[v['name'] for v in VAULTS]}")
    ThreadingHTTPServer((bind, port), Handler).serve_forever()


if __name__ == "__main__":
    main()
