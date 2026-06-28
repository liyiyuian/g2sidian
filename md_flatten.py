#!/usr/bin/env python3
"""Flatten Obsidian-flavored Markdown into clean plain-text LINES for the G2 glasses
(576x288, ONE proportional font, ~10 lines). This is a deterministic regex/state-machine
pass — NOT a CommonMark engine. Goal: drop markup noise, keep the words.

Also exposes split_frontmatter(), which the write path uses so an append never touches the
`---` frontmatter block.

What it does:
  - splits & ignores leading `---` YAML frontmatter (a shallow read pulls tags/aliases/title
    for one compact header line — never a YAML round-trip)
  - drops %%comments%% (inline and block) and fenced ```code``` fences (keeps the code text)
  - [[a|b]] -> "b", [[a#h]] -> "a > h", [[a#^id]]/[[a]] -> "a";  ![[x]] -> "[embed: x]"
  - [text](url) -> "text";  ![alt](url) -> "[image: alt]"
  - tasks "- [ ]/[x]" -> a state glyph; bullets/numbered lists kept; Tasks-plugin emoji dates stripped
  - callouts "> [!type] Title" -> a plain header; blockquotes de-`>`-ed
  - unwraps **bold** *italic* ==hl== ~~strike~~ `code`; strips footnote refs and trailing ^blockid
  - tables -> "cell - cell"; `---` rules -> a divider; keeps #tags, headings, $math$ raw
Line WRAPPING to the pixel width happens on the glasses (even-toolkit pretext) — this returns
logical lines only.
"""
import re

# ---- frontmatter ----------------------------------------------------------

# body is OPTIONAL so an empty `---\n---` (all properties removed) is still recognized as frontmatter
_FM_RE = re.compile(r"^---\r?\n(?:.*?\r?\n)?---[ \t]*\r?\n?", re.S)


def split_frontmatter(text):
    """(frontmatter_with_delimiters, body). frontmatter='' if the file doesn't open with one.
    Byte-exact: the body starts immediately after the closing `---` line, so callers can write
    the frontmatter back untouched."""
    if text.startswith("---\n") or text.startswith("---\r\n"):
        m = _FM_RE.match(text)
        if m:
            return text[: m.end()], text[m.end():]
    return "", text


# `.*` (not `.+`) so a bare `tags:` with the list on the following `  - item` lines still matches
# (block-list form is the most common Obsidian tag style)
_TAGS_INLINE_RE = re.compile(r"^(tags|aliases|alias)\s*:\s*(.*)$", re.I)
_TITLE_RE = re.compile(r"^(title|name)\s*:\s*(.+)$", re.I)
_LIST_ITEM_RE = re.compile(r"^\s*-\s*(.+)$")


def parse_frontmatter(fm):
    """Best-effort SHALLOW parse for a header line: {tags:[...], aliases:[...], title:str}.
    Never raises; not a real YAML parser (stdlib has none and we won't add one)."""
    meta = {"tags": [], "aliases": [], "title": ""}
    if not fm:
        return meta
    inner = re.sub(r"^---\r?\n", "", fm)
    inner = re.sub(r"\r?\n---[ \t]*\r?\n?$", "", inner)
    lines = inner.split("\n")
    i = 0

    def clean_list(v):
        v = v.strip()
        # a bracketed [a, b] list splits on COMMAS only (so "John Smith" stays one alias); a bare
        # scalar splits on commas+whitespace (so `tags: project alpha` -> two tags)
        if v.startswith("[") and v.endswith("]"):
            parts = v[1:-1].split(",")
        else:
            parts = re.split(r"[,\s]+", v)
        out = []
        for part in parts:
            p = part.strip().strip("\"'").lstrip("#")
            if p:
                out.append(p)
        return out

    while i < len(lines):
        ln = lines[i]
        mt = _TITLE_RE.match(ln)
        if mt and not meta["title"]:
            meta["title"] = mt.group(2).strip().strip("\"'")
            i += 1
            continue
        m = _TAGS_INLINE_RE.match(ln)
        if m:
            key = "aliases" if m.group(1).lower().startswith("alias") else "tags"
            val = m.group(2).strip()
            if val and val not in ("|", ">"):
                meta[key].extend(clean_list(val))
            else:
                # block list on the following indented `- item` lines
                j = i + 1
                while j < len(lines) and (_LIST_ITEM_RE.match(lines[j]) or not lines[j].strip()):
                    im = _LIST_ITEM_RE.match(lines[j])
                    if im:
                        meta[key].append(im.group(1).strip().strip("\"'").lstrip("#"))
                    elif lines[j].strip():
                        break
                    j += 1
                i = j
                continue
        i += 1
    # de-dupe, keep order
    for k in ("tags", "aliases"):
        seen, out = set(), []
        for v in meta[k]:
            if v and v not in seen:
                seen.add(v)
                out.append(v)
        meta[k] = out
    return meta


# ---- inline transforms ----------------------------------------------------

_EMBED_WIKI_RE = re.compile(r"!\[\[([^\]]+)\]\]")
_EMBED_MD_RE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_WIKI_RE = re.compile(r"\[\[([^\]]+)\]\]")
_MDLINK_RE = re.compile(r"\[([^\]]*)\]\(([^)]*)\)")
_FOOTNOTE_REF_RE = re.compile(r"\[\^[^\]]+\]")
_BLOCKID_RE = re.compile(r"\s+\^[\w-]+\s*$")
_BR_RE = re.compile(r"<br\s*/?>", re.I)
# Tasks-plugin metadata, stripped from task lines (these glyphs don't render in the G2 font):
#   DATE pairs (📅/⏳/🛫/✅/➕/❌ + YYYY-MM-DD) anywhere, recurrence (🔁 every …), priority emojis.
# DATE-ANCHORED so it never eats real text — e.g. "Buy milk ✅ done shopping" (no date) is preserved.
_TASK_EMOJI_RE = re.compile(
    r"\s*(?:[📅⏳🛫✅➕❌]\s*\d{4}-\d{2}-\d{2}|🔁\s*every\b[^📅⏳🛫✅➕❌🔺⏫🔼🔽⏬#]*|[🔺⏫🔼🔽⏬])")

_BOLD_RE = re.compile(r"\*\*(.+?)\*\*")
_BOLD2_RE = re.compile(r"__(.+?)__")
_ITAL_RE = re.compile(r"(?<![\*\w])\*(?!\s)(.+?)(?<!\s)\*(?![\*\w])")
_ITAL2_RE = re.compile(r"(?<![_\w])_(?!\s)(.+?)(?<!\s)_(?![_\w])")
_HL_RE = re.compile(r"==(.+?)==")
_STRIKE_RE = re.compile(r"~~(.+?)~~")
_CODE_RE = re.compile(r"`([^`]+)`")
_COMMENT_INLINE_RE = re.compile(r"%%.*?%%", re.S)


def _wiki_display(inner):
    """[[target|alias]] -> alias; [[target#h]] -> 'target > h'; [[t#^id]]/[[t]] -> target basename."""
    inner = inner.strip()
    if "|" in inner:
        target, alias = inner.split("|", 1)
        return alias.strip()
    target = inner
    heading = ""
    if "#" in target:
        target, _, frag = target.partition("#")
        if frag and not frag.startswith("^"):
            heading = frag.strip()
    target = target.strip()
    base = target.rsplit("/", 1)[-1] if target else target
    return f"{base} > {heading}" if heading else base


def inline(text):
    """Public: flatten inline markup (wikilinks/links/embeds/emphasis) in a single string.
    Used by vault_query to clean rendered task descriptions the same way the reader does."""
    return _inline(text)


def _inline(text):
    text = _BR_RE.sub(" ", text)
    text = _COMMENT_INLINE_RE.sub("", text)
    text = _EMBED_WIKI_RE.sub(lambda m: f"[embed: {_wiki_display(m.group(1))}]", text)
    text = _EMBED_MD_RE.sub(lambda m: f"[image: {m.group(1)}]" if m.group(1).strip() else "[image]", text)
    text = _WIKI_RE.sub(lambda m: _wiki_display(m.group(1)), text)
    text = _MDLINK_RE.sub(lambda m: m.group(1) or m.group(2), text)
    text = _FOOTNOTE_REF_RE.sub("", text)
    text = _BOLD_RE.sub(r"\1", text)
    text = _BOLD2_RE.sub(r"\1", text)
    text = _HL_RE.sub(r"\1", text)
    text = _STRIKE_RE.sub(r"\1", text)
    text = _ITAL_RE.sub(r"\1", text)
    text = _ITAL2_RE.sub(r"\1", text)
    text = _CODE_RE.sub(r"\1", text)
    return text


# ---- line-level transforms ------------------------------------------------

_FENCE_RE = re.compile(r"^\s*(```+|~~~+)(.*)$")
# closing hashes must be whitespace-separated, so "# C#" keeps its '#' (not "# Heading #" markup)
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$")
_HR_RE = re.compile(r"^\s*([-*_])(\s*\1){2,}\s*$")
_CALLOUT_RE = re.compile(r"^>\s*\[!(\w+)\][+-]?\s*(.*)$")
_QUOTE_RE = re.compile(r"^>\s?(.*)$")
# any single-char status (Tasks plugin allows custom statuses: [ ] [x] [/] [>] [-] …)
_TASK_RE = re.compile(r"^(\s*)[-*+]\s+\[(.)\]\s+(.*)$")
_BULLET_RE = re.compile(r"^(\s*)[-*+]\s+(.*)$")
_NUM_RE = re.compile(r"^(\s*)(\d+)[.)]\s+(.*)$")
_TABLE_SEP_RE = re.compile(r"^\s*\|?[\s:|-]+\|?\s*$")
_TABLE_ROW_RE = re.compile(r"^\s*\|(.+)\|\s*$")

# ASCII brackets, not ballot-box glyphs (☐/☑) — the G2 firmware font lacks the latter (verified
# blank in the simulator, which mirrors the firmware's missing-glyph handling).
_TASK_GLYPH = {" ": "[ ]", "x": "[x]", "X": "[x]", "/": "[/]", "-": "[-]", "?": "[?]", "!": "[!]"}


# Dynamic blocks rendered by Obsidian plugins (Tasks/Dataview). We hand the query to an injected
# runner (vault_query) that renders a faithful SUBSET; anything it can't do safely -> a placeholder
# (never the raw query source, and never a wrong/partial result).
_DYN_KINDS = {"dataview", "dataviewjs", "tasks"}


def _render_dynamic(kind, query, runner):
    lines = None
    if runner is not None:
        try:
            lines = runner(kind, query)
        except Exception:
            lines = None
    if lines is not None:
        return lines  # faithfully rendered results
    first = next((ln.strip() for ln in query.split("\n") if ln.strip()), "")
    hint = " · " + first[:40] if (kind != "dataviewjs" and first) else ""
    return [f"⟨{kind} view — open in Obsidian{hint}⟩"]


def flatten(text, query_runner=None):
    """Return {"title":str, "tags":[...], "aliases":[...], "lines":[...]}.
    `lines` are logical lines (the glasses pixel-wraps each). `query_runner(kind, query_text)` (optional)
    renders ```tasks / ```dataview blocks to lines, or returns None for a placeholder."""
    fm, body = split_frontmatter(text)
    meta = parse_frontmatter(fm)
    out = []
    in_code = False
    code_char, code_len = "", 0
    dyn_kind, dyn_buf = None, []
    in_comment = False

    def push(line):
        if line == "" and (not out or out[-1] == ""):
            return  # collapse runs of blank lines
        out.append(line)

    for raw in body.split("\n"):
        line = raw.replace("\t", "    ").rstrip()

        # PRECEDENCE: an open %% comment hides everything (incl. fences); then code is verbatim.
        if in_comment:
            if "%%" not in line:
                continue
            in_comment = False
            line = line.split("%%", 1)[1]
            if not line.strip():
                continue
        elif in_code:
            fm = _FENCE_RE.match(line)
            # close ONLY on a same-char fence at least as long, with no info string (so a longer
            # outer fence documenting an inner ``` block doesn't terminate early)
            if fm and fm.group(1)[0] == code_char and len(fm.group(1)) >= code_len and not fm.group(2).strip():
                in_code = False
                if dyn_kind is not None:  # dataview/tasks block -> render results or a placeholder
                    for rl in _render_dynamic(dyn_kind, "\n".join(dyn_buf), query_runner):
                        push(rl)
                    dyn_kind, dyn_buf = None, []
            elif dyn_kind is not None:
                dyn_buf.append(raw.rstrip("\r"))  # buffer query source for the runner
            else:
                out.append(raw.rstrip("\r"))  # plain code content verbatim
            continue
        else:
            if line.count("%%") % 2 == 1:        # opening a block comment
                line = line.split("%%")[0]
                in_comment = True
                if not line.strip():
                    continue
            else:
                fm = _FENCE_RE.match(line)        # opening a code fence
                if fm:
                    in_code, code_char, code_len = True, fm.group(1)[0], len(fm.group(1))
                    info = fm.group(2).strip().lower()
                    dyn_kind, dyn_buf = (info if info in _DYN_KINDS else None), []
                    continue

        if not line.strip():
            push("")
            continue
        line = _BLOCKID_RE.sub("", line)  # strip a trailing ^blockid on EVERY line type

        m = _HEADING_RE.match(line)
        if m:
            push("")
            push(f"{'#' * min(len(m.group(1)), 3)} {_inline(m.group(2))}".rstrip())
            continue

        if _HR_RE.match(line):
            push("──────")
            continue

        m = _CALLOUT_RE.match(line)
        if m:
            title = _inline(m.group(2)).strip() or m.group(1).upper()
            push(f"❝ {title}")
            continue
        m = _QUOTE_RE.match(line)
        if m:
            push(f"│ {_inline(m.group(1))}".rstrip())
            continue

        m = _TASK_RE.match(line)
        if m:
            indent = " " * len(m.group(1))
            txt = _TASK_EMOJI_RE.sub("", _inline(m.group(3))).strip()
            glyph = _TASK_GLYPH.get(m.group(2)) or f"[{m.group(2)}]"
            push(f"{indent}{glyph} {txt}")
            continue
        m = _NUM_RE.match(line)
        if m:
            push(f"{' ' * len(m.group(1))}{m.group(2)}. {_inline(m.group(3))}")
            continue
        m = _BULLET_RE.match(line)
        if m:
            push(f"{' ' * len(m.group(1))}• {_inline(m.group(2))}")
            continue

        if _TABLE_SEP_RE.match(line) and "|" in line and "-" in line:
            continue
        m = _TABLE_ROW_RE.match(line)
        if m:
            cells = [c.strip() for c in m.group(1).split("|")]
            push(_inline(" — ".join(c for c in cells if c)))
            continue

        push(_inline(line))

    while out and out[-1] == "":
        out.pop()
    while out and out[0] == "":
        out.pop(0)
    if not meta["title"]:
        # first heading or first non-empty line as a fallback title
        for ln in out:
            t = ln.lstrip("# ").strip()
            if t:
                meta["title"] = t
                break
    return {"title": meta["title"], "tags": meta["tags"], "aliases": meta["aliases"], "lines": out}


if __name__ == "__main__":
    import json
    import sys

    with open(sys.argv[1], encoding="utf-8", errors="replace") as f:
        data = flatten(f.read())
    if "--json" in sys.argv:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        hdr = data["title"]
        if data["tags"]:
            hdr += "  " + " ".join("#" + t for t in data["tags"])
        print("== " + hdr + " ==")
        for ln in data["lines"]:
            print(ln)
