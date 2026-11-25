"""Frontmatter tags in the vault index (#tag search, Dataview FROM #tag).
   python3 tests/test_vault_query.py <backend-dir>"""
import os, shutil, sys, tempfile
BE = sys.argv[1]
sys.path.insert(0, BE)
import vault_query
ok = fail = 0
def check(name, cond, info=""):
    global ok, fail
    print(("  PASS  " if cond else "  FAIL  ") + name + ("" if cond else f"   -> {info}")); ok += bool(cond); fail += (not cond)
BLOCK = "---\ntags:\n  - project\n  - urgent\naliases:\n  - Foo\ncssclasses:\n  - wide\n---\nBody #inline\n"
t = vault_query._note_tags(BLOCK); check("block-list tags: every item, stops at the next key", t == {"project", "urgent", "inline"}, t)
t = vault_query._note_tags("---\ntags:\ncreated: 2026-01-01\n---\nBody\n"); check("empty tags: then another key -> no tags", t == set(), t)
t = vault_query._note_tags("---\ntags: [a, b]\n---\nBody\n"); check("inline [a, b]", t == {"a", "b"}, t)
t = vault_query._note_tags("---\ntags: a, b\n---\nBody\n"); check("inline a, b", t == {"a", "b"}, t)
t = vault_query._note_tags("---\ntag: solo\n---\nBody\n"); check("singular tag: key", t == {"solo"}, t)
t = vault_query._note_tags("No frontmatter #x/y\n"); check("no frontmatter: body tags only", t == {"x/y"}, t)
V = tempfile.mkdtemp(prefix="g2s-vq-")
try:
    open(os.path.join(V, "Note.md"), "w").write(BLOCK); open(os.path.join(V, "Other.md"), "w").write("# Other\n")
    r = vault_query.notes_with_tag(V, "#urgent"); check("notes_with_tag finds the 2nd block-list tag", [n["path"] for n in r] == ["Note.md"], r)
    r = vault_query.notes_with_tag(V, "#-"); check("no junk '-' tag", r == [], r)
finally:
    shutil.rmtree(V, ignore_errors=True)
print(f"RESULT vault_query vs {BE}: {ok} passed, {fail} failed"); sys.exit(1 if fail else 0)
