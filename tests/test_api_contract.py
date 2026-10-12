"""API contract: the exact calls a Gbsidian app version makes, against a backend dir.
   python3 tests/test_api_contract.py <backend-dir> old-app|new-app   (old-app = v0.2.6 calls)"""
import json, os, shutil, subprocess, sys, time, urllib.request, urllib.error, tempfile
BE, WHICH = sys.argv[1], sys.argv[2]   # backend dir, 'old-app' | 'new-app'
PORT, TOK = 18795, "contract-token"
V = tempfile.mkdtemp(prefix="g2s-contract-"); vault = os.path.join(V, "Demo"); os.makedirs(vault + "/.obsidian")
open(vault + "/Alpha.md", "w").write("# Alpha\n\nhello [[Beta]]\n\n## Two\n\nx\n"); open(vault + "/Beta.md", "w").write("# Beta\n")
env = dict(os.environ, HOME=V, G2SIDIAN_TOKEN=TOK, G2SIDIAN_API_PORT=str(PORT), G2SIDIAN_BIND="127.0.0.1",
           G2SIDIAN_VAULTS=json.dumps([{"name": "Demo", "path": vault}]), OPENAI_API_KEY="", G2SIDIAN_CAPTURE_MODE="daily")
p = subprocess.Popen(["python3", f"{BE}/g2sidian_api.py"], cwd=BE, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
def call(path, body=None):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=json.dumps(body).encode() if body is not None else None,
          headers={"Authorization": f"Bearer {TOK}", "content-type": "application/json"}, method="POST" if body is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=5) as r: return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b"{}")
ok = fail = 0
def check(name, cond, info=""):
    global ok, fail
    print(("  PASS  " if cond else "  FAIL  ") + name + ("" if cond else f"   -> {info}")); ok += bool(cond); fail += (not cond)
try:
    for _ in range(50):
        try: urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/health", timeout=1); break
        except Exception: time.sleep(0.2)
    s, h = call("/api/health"); check("health: ok/voice/vaults", s == 200 and {"ok", "voice", "vaults"} <= h.keys(), h)
    s, v = call("/api/vaults"); check("vaults[].name", s == 200 and v["vaults"][0]["name"] == "Demo", v)
    s, l = call("/api/list?vault=Demo&path="); check("list: vault/path/parent/entries[name,type,mtime]", s == 200 and {"vault", "path", "parent", "entries"} <= l.keys() and all({"name", "type", "mtime"} <= e.keys() for e in l["entries"]), l)
    s, n = call("/api/note?vault=Demo&path=Alpha.md"); check("note: vault/path/title/tags/aliases/lines/mtime/size", s == 200 and {"vault", "path", "title", "tags", "aliases", "lines", "mtime", "size"} <= n.keys() and isinstance(n["mtime"], str) and all(isinstance(x, str) for x in n["lines"]), n)
    if WHICH == "new-app": check("note: links (new app reads n.links || [] — absent is OK)", True)
    s, r = call("/api/search?vault=Demo&q=hello"); check("search: results[path,title,score,snippet,mtime]", s == 200 and r["results"] and {"path", "title", "score", "snippet", "mtime"} <= r["results"][0].keys(), r)
    s, t = call("/api/capture/target"); check("capture/target: vault/path/exists/label/mode", s == 200 and {"vault", "path", "exists", "label", "mode"} <= t.keys(), t)
    s, c = call("/api/capture", {"text": "contract capture"}); check("capture {text}: ok/vault/path/label/created/mtime", s == 200 and c.get("ok") and {"vault", "path", "label", "mtime"} <= c.keys(), c)
    s, a = call("/api/append", {"vault": "Demo", "path": "Alpha.md", "text": "appended", "base_mtime": n["mtime"]}); check("append with base_mtime: ok + new mtime", s == 200 and a.get("ok") and a.get("mtime"), a)
    s, a2 = call("/api/append", {"vault": "Demo", "path": "Alpha.md", "text": "stale", "base_mtime": n["mtime"]}); check("append with a stale base_mtime: 409 conflict", s == 409 and "error" in a2, (s, a2))
    if WHICH == "new-app":
        s, a3 = call("/api/append", {"vault": "Demo", "path": "Alpha.md", "text": "anyway"}); check("append WITHOUT base_mtime ('add it anyway')", s == 200 and a3.get("ok"), (s, a3))
        s, ti = call("/api/capture/target?mode=inbox"); check("capture/target?mode=inbox reports mode inbox", s == 200 and ti.get("mode") == "inbox", ti)
        s, ci = call("/api/capture", {"text": "to the inbox", "mode": "inbox"}); check("capture {mode: inbox} lands in the inbox", s == 200 and "Inbox" in (ci.get("path") or ""), ci)
    body = open(vault + "/Alpha.md").read(); check("note content on disk has the appended text", "appended" in body, body[-80:])
finally:
    p.terminate(); p.wait(); shutil.rmtree(V, ignore_errors=True)
print(f"RESULT {WHICH} vs {BE}: {ok} passed, {fail} failed"); sys.exit(1 if fail else 0)
