"""vault_query Tasks subset: filters and sorts must match the Tasks plugin, or bail to a placeholder (None).
   python3 tests/test_tasks_query.py"""
import os, shutil, sys, tempfile
from datetime import date
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import vault_query

TODAY = date(2026, 2, 1)  # fixed, so 'tomorrow' and the dates below never drift
V = tempfile.mkdtemp(prefix="g2s-vq-")
open(os.path.join(V, "Plan.md"), "w", encoding="utf-8").write("\n".join([
    "- [ ] plain", "- [ ] dated 📅 2026-01-10", "- [ ] later 🛫 2026-03-01", "- [ ] early 🛫 2026-01-20",
    "- [ ] top 🔺", "- [ ] hi ⏫", "- [ ] med 🔼", "- [ ] lo 🔽", ""]))
ALL = {"plain", "dated", "later", "early", "top", "hi", "med", "lo"}
ok = fail = 0
def check(name, cond, info=""):
    global ok, fail
    print(("  PASS  " if cond else "  FAIL  ") + name + ("" if cond else f"   -> {info}")); ok += bool(cond); fail += (not cond)
def descs(q):
    r = vault_query._run_tasks(V, q, TODAY)
    return r if r is None else [ln[4:].split()[0] for ln in r if ln != "(no matching tasks)"]
def same(q, want):
    got = descs(q); check(q, got is not None and set(got) == want, got)
try:
    same("has happens date", {"dated", "later", "early"})
    same("no happens date", {"plain", "top", "hi", "med", "lo"})
    same("priority is none", {"plain", "dated", "later", "early"})
    same("priority is above none", {"top", "hi", "med"})
    same("priority is below high", ALL - {"top", "hi"})
    same("priority is not low", ALL - {"lo"})
    same("priority is highest", {"top"})
    got = descs("priority is urgent"); check("priority is urgent -> placeholder (None)", got is None, got)
    same("starts before tomorrow", ALL - {"later"})  # Tasks: no start date also matches
    same("starts after 2026-02-15", ALL - {"early"})
    got = descs("sort by priority\nlimit 3")
    check("sort by priority + limit 3 -> highest first", got == ["top", "hi", "med"], got)
    got = descs("sort by priority reverse\nlimit 1")
    check("sort by priority reverse + limit 1", got == ["lo"], got)
    got = descs("path includes {{query.file.path}}")
    check("{{query.file.path}} -> placeholder (None)", got is None, got)
finally:
    shutil.rmtree(V, ignore_errors=True)
print(f"RESULT vault_query: {ok} passed, {fail} failed"); sys.exit(1 if fail else 0)
