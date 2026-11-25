"""openai_key(): in ~/.env and the shell rc files only OPENAI_API_KEY=... counts, never another
   provider's sk-... key; a bare sk-... still counts in a key file or a path given for the key.
   python3 tests/test_openai_key.py"""
import os, shutil, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.pop("OPENAI_API_KEY", None)
import g2sidian_api as api
OPENAI, OTHER, DEEPSEEK = "sk-proj-" + "a1" * 20, "sk-or-v1-" + "0123456789abcdef" * 2, "sk-" + "0123456789abcdef" * 2
ok = fail = 0
def check(name, got, want):
    global ok, fail
    print(("  PASS  " if got == want else "  FAIL  ") + name + ("" if got == want else f"   -> {got!r}, want {want!r}")); ok += got == want; fail += got != want
def key(files, override=None, env_path=None):
    home = tempfile.mkdtemp(prefix="g2s-key-"); os.environ["HOME"] = home
    os.environ.pop("G2SIDIAN_OPENAI_KEY_PATH", None)
    if env_path: os.environ["G2SIDIAN_OPENAI_KEY_PATH"] = env_path
    try:
        for rel, body in files.items():
            os.makedirs(os.path.dirname(os.path.join(home, rel)), exist_ok=True)
            open(os.path.join(home, rel), "w").write(body)
        return api.openai_key(override)
    finally:
        shutil.rmtree(home, ignore_errors=True)
check("another provider's key in ~/.zshrc is not used", key({".zshrc": f"export OPENROUTER_API_KEY={OTHER}\n"}), "")
check("a bare sk-... in ~/.bashrc is not used", key({".bashrc": f"DEEPSEEK_API_KEY='{DEEPSEEK}'\n"}), "")
check("an Anthropic key is not used", key({".env": "ANTHROPIC_API_KEY=sk-ant-" + "x" * 30 + "\n"}), "")
check("export OPENAI_API_KEY=... in ~/.zshrc", key({".zshrc": f"export OPENAI_API_KEY={OPENAI}\n"}), OPENAI)
check("a foreign key in ~/.env does not hide OPENAI_API_KEY in ~/.zshrc",
      key({".env": f"OPENROUTER_API_KEY={OTHER}\n", ".zshrc": f"export OPENAI_API_KEY={OPENAI}\n"}), OPENAI)
check("a bare key in ~/.config/openai/key", key({".config/openai/key": OPENAI + "\n"}), OPENAI)
check("a bare key in the Setup key-file path, even ~/.zshrc", key({".zshrc": OPENAI + "\n"}, override="~/.zshrc"), OPENAI)
check("a bare key in G2SIDIAN_OPENAI_KEY_PATH, even ~/.zshrc", key({".zshrc": OPENAI + "\n"}, env_path="~/.zshrc"), OPENAI)
print(f"RESULT openai_key: {ok} passed, {fail} failed"); sys.exit(1 if fail else 0)
