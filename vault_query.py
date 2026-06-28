#!/usr/bin/env python3
"""Render a FAITHFUL SUBSET of Obsidian Tasks-plugin and Dataview (DQL) query blocks server-side,
so the glasses can show the *results* of a ```tasks / ```dataview block instead of its raw source.

Hard rule — NEVER MISLEAD: tasks/dataview drive what you act on, so we must not silently drop a
filter (which would broaden the result and hide nothing / show too much). Any query that uses a
feature we don't fully implement returns None, and the caller renders a placeholder + the raw query
instead of a wrong answer. `dataviewjs` is arbitrary JavaScript — always None (we can't run it).

Backed by an mtime-cached per-vault index (notes + parsed tasks), rebuilt only when the vault changes.
stdlib only. `today` is read fresh per call.
"""
import os
import re
from datetime import datetime, date

import md_flatten  # for inline-markup cleaning of rendered task descriptions (no cycle: md_flatten imports neither)

# ---- Tasks-plugin emoji metadata -----------------------------------------
DUE, SCHED, START, DONE_E, CREATED, CANCELLED = "📅", "⏳", "🛫", "✅", "➕", "❌"
RECUR = "🔁"
PRIOS = {"🔺": "highest", "⏫": "high", "🔼": "medium", "🔽": "low", "⏬": "lowest"}
_DATE_EMOJI = DUE + SCHED + START + DONE_E + CREATED + CANCELLED
_ALL_EMOJI = _DATE_EMOJI + RECUR + "".join(PRIOS)

_TASK_LINE_RE = re.compile(r"^(\s*)[-*+]\s+\[(.)\]\s+(.*)$")
_DATEPAIR_RE = {
    "due": re.compile(DUE + r"\s*(\d{4}-\d{2}-\d{2})"),
    "scheduled": re.compile(SCHED + r"\s*(\d{4}-\d{2}-\d{2})"),
    "start": re.compile(START + r"\s*(\d{4}-\d{2}-\d{2})"),
    "done": re.compile(DONE_E + r"\s*(\d{4}-\d{2}-\d{2})"),
}
_TAG_RE = re.compile(r"(?<![\w/])#([A-Za-z0-9_][A-Za-z0-9_/\-]*)")
# strip metadata to recover the plain description (date pairs, priority emojis, recurrence run)
_META_STRIP_RE = re.compile(
    r"\s*(?:[" + _DATE_EMOJI + r"]\s*\d{4}-\d{2}-\d{2}|[" + "".join(PRIOS) + r"]|" + RECUR + r"[^" + _DATE_EMOJI + r"]*)")

_SKIP_DIRS = {".obsidian", ".trash", ".git", ".stfolder", ".stversions", "node_modules"}


def _pdate(s):
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except ValueError:
        return None


def parse_task(raw, path):
    m = _TASK_LINE_RE.match(raw)
    if not m:
        return None
    status, body = m.group(2), m.group(3)
    t = {"path": path, "status": status, "done": status.lower() == "x",
         "tags": set(_TAG_RE.findall(body)), "priority": None,
         "due": None, "scheduled": None, "start": None, "done_date": None}
    for key, rx in _DATEPAIR_RE.items():
        mm = rx.search(body)
        if mm:
            t["done_date" if key == "done" else key] = _pdate(mm.group(1))
    for emoji, name in PRIOS.items():
        if emoji in body:
            t["priority"] = name
            break
    t["desc"] = _META_STRIP_RE.sub("", body).strip()
    return t


# ---- frontmatter tags (shallow) ------------------------------------------
_FM_RE = re.compile(r"^---\r?\n(.*?)\r?\n---", re.S)
_FM_TAGS_RE = re.compile(r"^(tags|tag)\s*:\s*(.*)$", re.I | re.M)


def _note_tags(text):
    tags = set()
    fm = _FM_RE.match(text)
    if fm:
        block = fm.group(1)
        for mt in _FM_TAGS_RE.finditer(block):
            val = mt.group(2).strip()
            if val.startswith("[") and val.endswith("]"):
                val = val[1:-1]
            if val:
                for part in re.split(r"[,\s]+", val):
                    p = part.strip().strip("\"'").lstrip("#")
                    if p:
                        tags.add(p)
            else:  # block list on following "  - tag" lines
                after = block[mt.end():]
                for lm in re.finditer(r"^\s*-\s*(.+)$", after, re.M):
                    if lm.group(1).strip():
                        tags.add(lm.group(1).strip().strip("\"'").lstrip("#"))
                    else:
                        break
        body = text[fm.end():]
    else:
        body = text
    tags |= set(_TAG_RE.findall(body))
    return tags


# ---- mtime-cached per-vault index ----------------------------------------
_CACHE = {}  # realpath(vault_root) -> {"sig": ..., "notes": [...], "tasks": [...]}


def _is_note(fn):
    return fn.endswith(".md") and not fn.endswith(".excalidraw.md")


def _scan_sig(root):
    parts = []
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if not d.startswith(".") and d not in _SKIP_DIRS]
        for fn in fns:
            if _is_note(fn):
                p = os.path.join(dp, fn)
                try:
                    st = os.stat(p)
                    parts.append((os.path.relpath(p, root), st.st_mtime_ns, st.st_size))
                except OSError:
                    pass
    parts.sort()
    return tuple(parts)


def _index(root):
    root = os.path.realpath(root)
    sig = _scan_sig(root)
    cached = _CACHE.get(root)
    if cached and cached["sig"] == sig:
        return cached
    notes, tasks = [], []
    for rel, _, _ in sig:
        full = os.path.join(root, rel)
        try:
            with open(full, encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError:
            continue
        title = os.path.basename(rel)[:-3]
        notes.append({"path": rel, "title": title, "tags": _note_tags(text)})
        for line in text.split("\n"):
            if "[" in line and "]" in line:
                t = parse_task(line, rel)
                if t:
                    tasks.append(t)
    _CACHE[root] = {"sig": sig, "notes": notes, "tasks": tasks}
    return _CACHE[root]


# ---- Tasks-plugin query subset -------------------------------------------
# A query = lines, ANDed. A line may be (clause) OR/AND (clause)... Modifiers: short mode, sort by,
# limit, hide/group/explain (ignored, presentation-only). Unknown filter line => unsupported (None).

def _split_top(s, op):
    """Split on ' OP ' at paren depth 0 (case-insensitive). Returns parts or [s] if op absent."""
    out, depth, last, i = [], 0, 0, 0
    pat = (" " + op + " ").lower()  # compare against the lowercased source below
    low = s.lower()
    while i < len(s):
        c = s[i]
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
        elif depth == 0 and low[i:i + len(pat)] == pat:
            out.append(s[last:i]); i += len(pat); last = i; continue
        i += 1
    out.append(s[last:])
    return out


def _strip_parens(s):
    s = s.strip()
    while s.startswith("(") and s.endswith(")"):
        s = s[1:-1].strip()
    return s


def _date_clause(field, rest, task, today):
    """Evaluate a date filter like 'before today' / 'today' / 'after 2026-01-01' / 'before <date>'.
    field in due/scheduled/start; 'happens' handled by caller. Returns bool or None (unsupported)."""
    rest = rest.strip()
    if field == "happens":
        vals = [task["due"], task["scheduled"], task["start"]]
    else:
        vals = [task[field]]
    if rest in ("no date", "") and field != "happens":
        return None  # ambiguous -> unsupported
    op, _, arg = rest.partition(" ")
    if rest in ("today",):
        return any(v == today for v in vals if v)
    if op in ("before", "after", "on") and arg:
        tgt = today if arg.strip() == "today" else _pdate(arg.strip())
        if not tgt:
            return None
        if op == "before":
            return any(v and v < tgt for v in vals)
        if op == "after":
            return any(v and v > tgt for v in vals)
        return any(v == tgt for v in vals)
    d = _pdate(rest)  # bare date == on that date
    if d:
        return any(v == d for v in vals)
    return None


def _eval_clause(clause, task, today):
    c = _strip_parens(clause).strip().lower()
    if c in ("done",):
        return task["done"]
    if c in ("not done",):
        return not task["done"]
    for f in ("due", "scheduled", "starts", "start", "happens"):
        field = "start" if f == "starts" else f
        if c == "has " + f.rstrip("s") + " date" or c == "has " + f + " date":
            return task.get(field) is not None
        if c == "no " + f.rstrip("s") + " date" or c == "no " + f + " date":
            return task.get(field) is None
        if c.startswith(f + " "):
            return _date_clause(field if field != "starts" else "start", c[len(f) + 1:], task, today)
    for verb, neg in (("path includes ", False), ("path does not include ", True)):
        if c.startswith(verb):
            hit = c[len(verb):].strip() in task["path"].lower()
            return (not hit) if neg else hit
    for verb, neg in (("description includes ", False), ("description does not include ", True)):
        if c.startswith(verb):
            hit = c[len(verb):].strip() in task["desc"].lower()
            return (not hit) if neg else hit
    for verb in ("tag includes ", "tags include "):
        if c.startswith(verb):
            q = c[len(verb):].strip().lstrip("#")
            return any(t.lower() == q or t.lower().startswith(q + "/") for t in task["tags"])
    if c.startswith("priority is "):
        return task["priority"] == c[len("priority is "):].strip()
    return None  # unrecognized -> unsupported


def _eval_line(line, task, today):
    for orpart in _split_top(line, "OR"):
        ok = True
        for andpart in _split_top(orpart, "AND"):
            r = _eval_clause(andpart, task, today)
            if r is None:
                return None
            if not r:
                ok = False
                break
        if ok:
            return True
    return False


_SORT_KEY = {"due": "due", "scheduled": "scheduled", "start": "start", "priority": "priority",
             "description": "desc", "path": "path"}


def _run_tasks(root, text, today):
    filters, short, limit, sort_field, sort_rev = [], False, None, None, False
    for raw in text.split("\n"):
        line = raw.strip()
        if not line:
            continue
        low = line.lower()
        if low == "short mode":
            short = True; continue
        if low in ("explain",) or low.startswith("hide ") or low.startswith("group by ") or low.startswith("show "):
            continue  # presentation-only -> ignore
        if low.startswith("limit "):
            try:
                limit = int(low[6:].strip()); continue
            except ValueError:
                return None
        if low.startswith("sort by "):
            rest = low[8:].split()
            f = _SORT_KEY.get(rest[0]) if rest else None
            if not f:
                return None
            sort_field, sort_rev = f, (len(rest) > 1 and rest[1] in ("reverse", "desc"))
            continue
        filters.append(line)
    idx = _index(root)
    out = []
    for t in idx["tasks"]:
        ok = True
        for ln in filters:
            r = _eval_line(ln, t, today)
            if r is None:
                return None  # any unsupported filter -> bail to placeholder (never broaden)
            if not r:
                ok = False
                break
        if ok:
            out.append(t)
    if sort_field:
        out.sort(key=lambda t: (t.get(sort_field) is None, t.get(sort_field) or ""), reverse=sort_rev)
    else:  # default: overdue/soonest first by due then scheduled
        out.sort(key=lambda t: (t["due"] is None and t["scheduled"] is None,
                                t["due"] or t["scheduled"] or date.max))
    if limit:
        out = out[:limit]
    return _render_tasks(out, today, short)


def _render_tasks(tasks, today, short):
    if not tasks:
        return ["(no matching tasks)"]
    lines = []
    for t in tasks:
        box = "[x]" if t["done"] else "[ ]"
        tail = ""
        d = t["due"] or t["scheduled"]
        if d:
            tail = " · overdue " + d.strftime("%m-%d") if d < today and not t["done"] else " · " + d.strftime("%m-%d")
        note = "" if short else "  (" + os.path.basename(t["path"])[:-3] + ")"
        lines.append(f"{box} {md_flatten.inline(t['desc'])}{tail}{note}")
    return lines


# ---- Dataview (DQL) subset: LIST / TASK, FROM #tag|"folder" (and/or), optional LIMIT/SORT ----
# WHERE / GROUP / FLATTEN / TABLE / expressions => unsupported (None).

def _from_match(note, source):
    """source = list of (kind, value, joiner) — supports #tag and "folder" joined by and/or."""
    result = None
    for kind, val, joiner in source:
        if kind == "tag":
            hit = any(tg.lower() == val or tg.lower().startswith(val + "/") for tg in note["tags"])
        else:  # folder
            hit = note["path"].lower() == val or note["path"].lower().startswith(val.rstrip("/") + "/")
        result = hit if result is None else (result or hit if joiner == "or" else result and hit)
    return bool(result)


def _parse_from(s):
    """Parse a FROM source into [(kind,value,joiner)] or None if it uses anything unsupported."""
    out, joiner = [], "and"
    for tok in re.split(r"\s+(and|or)\s+", s.strip(), flags=re.I):
        t = tok.strip()
        if t.lower() in ("and", "or"):
            joiner = t.lower(); continue
        if t.startswith("#"):
            out.append(("tag", t[1:].lower(), joiner))
        elif t.startswith('"') and t.endswith('"'):
            out.append(("folder", t[1:-1].strip().lower(), joiner))
        else:
            return None  # [[link]], outgoing(), csv, etc. -> unsupported
    return out or None


def _run_dataview(root, text, today):
    q = " ".join(ln.strip() for ln in text.split("\n") if ln.strip())
    if not q:
        return None
    low = q.lower()
    for bad in (" where ", " group by ", " flatten ", "table ", "calendar "):
        if low.startswith(bad.strip() + " ") or bad in low:
            return None  # unsupported feature -> placeholder
    m = re.match(r"^(list|task)\b(.*)$", q, re.I)
    if not m:
        return None
    qtype, rest = m.group(1).lower(), m.group(2).strip()
    limit = None
    ml = re.search(r"\blimit\s+(\d+)\b", rest, re.I)
    if ml:
        limit = int(ml.group(1)); rest = rest[:ml.start()].strip()
    rest = re.sub(r"\bsort\b.*$", "", rest, flags=re.I).strip()  # ignore SORT (presentation-only)
    mf = re.match(r"^(.*?)\bfrom\b\s+(.*)$", rest, re.I)
    if mf:
        expr, src = mf.group(1).strip(), mf.group(2).strip()
        source = _parse_from(src)
        if source is None:
            return None
    else:
        expr, source = rest.strip(), None  # no FROM = whole vault
    # LIST allows only a trivial expression (none / file.link / without id)
    if qtype == "list" and expr.lower() not in ("", "file.link", "rows", "without id"):
        return None
    idx = _index(root)
    if qtype == "list":
        notes = [n for n in idx["notes"] if source is None or _from_match(n, source)]
        notes.sort(key=lambda n: n["title"].lower())
        if limit:
            notes = notes[:limit]
        return ["• " + n["title"] for n in notes] or ["(none)"]
    # TASK: tasks whose note matches FROM
    paths = None if source is None else {n["path"] for n in idx["notes"] if _from_match(n, source)}
    tasks = [t for t in idx["tasks"] if paths is None or t["path"] in paths]
    tasks.sort(key=lambda t: (t["due"] is None and t["scheduled"] is None, t["due"] or t["scheduled"] or date.max))
    if limit:
        tasks = tasks[:limit]
    return _render_tasks(tasks, today, short=False)


# ---- entry point ---------------------------------------------------------
def run(vault_root, kind, query_text):
    """Render a dynamic block to lines, or None if unsupported (caller shows a placeholder).
    kind = the code-fence info string, lowercased ('tasks' | 'dataview' | 'dataviewjs' | ...)."""
    kind = (kind or "").strip().lower()
    if kind == "dataviewjs":
        return None  # arbitrary JS — cannot run
    today = datetime.now().date()
    try:
        if kind == "tasks":
            return _run_tasks(vault_root, query_text, today)
        if kind == "dataview":
            return _run_dataview(vault_root, query_text, today)
    except Exception:
        return None  # never let a query crash a note read
    return None
