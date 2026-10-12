#!/usr/bin/env bash
# install.sh tests — run before every release:  bash tests/test_install.sh
# Sandboxed: temp HOME, G2SIDIAN_DRYRUN=1 (no systemd / sudo / tailscale changes), test port 18794.
#   T2  OLD version fresh install (OLD_REF, default the last release; ONE_LINER=1 = the public curl|bash)
#   T3  upgrade OLD -> this tree (token, key, vaults, port, hand-added lines kept; service restarted)
#   T4  re-run is a no-op        T1  fresh install of this tree
# Then the API contract: OLD app vs NEW backend and NEW app vs OLD backend (tests/test_api_contract.py).
set -uo pipefail
NEW=$(cd "$(dirname "$0")/.." && pwd); OLD_REF=${OLD_REF:-c489630}   # c489630 = v0.2.6 (live on the hub)
S=$(mktemp -d); PIDS=(); trap 'for p in "${PIDS[@]}"; do kill $p 2>/dev/null; done; rm -rf "$S"' EXIT
mkdir -p $S/old; for f in install.sh g2sidian_api.py md_flatten.py vault_query.py; do git -C $NEW show $OLD_REF:$f > $S/old/$f; done
PASS=0; FAIL=0
check(){ if eval "$2"; then echo "  PASS  $1"; PASS=$((PASS+1)); else echo "  FAIL  $1"; FAIL=$((FAIL+1)); fi; }
mkvault(){ mkdir -p "$1/Demo/.obsidian"; printf '# Alpha\n\nhello\n' > "$1/Demo/Alpha.md"
  printf '{"items":[{"type":"file","path":"Alpha.md"}]}' > "$1/Demo/.obsidian/bookmarks.json"; }
backend(){ # start the INSTALLED backend with the INSTALLED env file; echo pid
  # load the env file like systemd's EnvironmentFile (KEY=VALUE verbatim; bash `source` would strip the JSON's quotes)
  ( HOME="$1" exec python3 -c 'import os,sys
for l in open(sys.argv[1]):
    l=l.rstrip("\n")
    if l and not l.startswith("#") and "=" in l: k,v=l.split("=",1); os.environ[k]=v
os.execvp("python3",["python3",sys.argv[2]])' "$1/.config/g2sidian.env" "$1/.local/share/g2sidian/g2sidian_api.py" ) >"$S/backend.log" 2>&1 &
  echo $!; }

code(){ curl -s -o /dev/null -w '%{http_code}' -m 5 -H "Authorization: Bearer $2" "http://127.0.0.1:18794$1"; }
waitup(){ for i in $(seq 30); do [ "$(code /api/health x)" != 000 ] && return 0; sleep 0.3; done; return 1; }
envkeys(){ cut -d= -f1 "$1/.config/g2sidian.env" | tr '\n' ' '; }

echo "== T2: OLD version ($OLD_REF$([ "${ONE_LINER:-0}" = 1 ] && echo ', public one-liner')) fresh install"
H=$S/h-old; mkdir -p $H; mkvault $S/vault-old
if [ "${ONE_LINER:-0}" = 1 ]; then OLDCMD='curl -fsSL https://raw.githubusercontent.com/liyiyuian/g2sidian/main/install.sh | bash'
else OLDCMD="G2SIDIAN_SRC=$S/old bash $S/old/install.sh"; fi
( cd $H && setsid env HOME=$H XDG_CONFIG_HOME=$H/.config G2SIDIAN_DRYRUN=1 G2SIDIAN_API_PORT=18794 \
  G2SIDIAN_VAULTS_OVERRIDE="[{\"name\":\"Demo\",\"path\":\"$S/vault-old/Demo\"}]" \
  G2SIDIAN_OPENAI_KEY=sk-test-oldkey-AAAAAAAAAAAAAAAAAAAAAAAA bash -c "$OLDCMD" ) > $S/t2.log 2>&1
check "old installer exits OK" "grep -q 'backend is up' $S/t2.log"
check "the OLD backend was installed (no /api/recent route)" "! grep -q '/api/recent' $H/.local/share/g2sidian/g2sidian_api.py"
TOK=$(sed -n 's/^G2SIDIAN_TOKEN=//p' $H/.config/g2sidian.env)
P=$(backend $H); PIDS+=($P); waitup
check "old backend: health 200 + list 200" "[ \$(code /api/health $TOK) = 200 ] && [ \$(code '/api/list?vault=Demo&path=' $TOK) = 200 ]"
check "old backend: /api/recent is 404 (what the new app's message handles)" "[ \$(code '/api/recent?vault=Demo' $TOK) = 404 ]"
kill $P; wait $P 2>/dev/null
# what a user may have added by hand since
printf 'G2SIDIAN_CAPTURE_VAULT=Demo\n# my note\nG2SIDIAN_INBOX_PATH=In/Box.md\n' >> $H/.config/g2sidian.env
cp $H/.config/g2sidian.env $S/env-before-upgrade

echo "== T3: UPGRADE old -> new (re-run the NEW installer, non-interactive, no key given)"
( cd $S && setsid env HOME=$H XDG_CONFIG_HOME=$H/.config G2SIDIAN_DRYRUN=1 G2SIDIAN_SRC=$NEW bash $NEW/install.sh ) > $S/t3.log 2>&1
E=$H/.config/g2sidian.env
check "new installer exits OK" "grep -q 'backend is up' $S/t3.log"
check "token kept" "[ \"\$(sed -n 's/^G2SIDIAN_TOKEN=//p' $E)\" = '$TOK' ]"
check "OpenAI key kept (was dropped before the fix)" "grep -qx 'OPENAI_API_KEY=sk-test-oldkey-AAAAAAAAAAAAAAAAAAAAAAAA' $E"
check "vaults kept" "grep -q 'vault-old/Demo' $E"
check "port kept (18794)" "grep -qx 'G2SIDIAN_API_PORT=18794' $E"
check "hand-added lines + comment kept" "grep -qx 'G2SIDIAN_CAPTURE_VAULT=Demo' $E && grep -qx 'G2SIDIAN_INBOX_PATH=In/Box.md' $E && grep -qx '# my note' $E"
check "old default date format removed (daily notes follow Obsidian)" "! grep -q '^G2SIDIAN_DAILY_FORMAT=' $E"
check "env file is chmod 600" "[ \$(stat -c %a $E) = 600 ]"
check "upgrade restarts the running service" "grep -q 'restart g2sidian.service' $S/t3.log"
check "new backend files installed" "grep -q '/api/recent' $H/.local/share/g2sidian/g2sidian_api.py"
P=$(backend $H); PIDS+=($P); waitup
check "upgraded backend: list/recent/bookmarks/tasks 200" "( for u in '/api/list?vault=Demo&path=' '/api/recent?vault=Demo' '/api/bookmarks?vault=Demo' '/api/tasks/due?vault=Demo'; do [ \$(code \"\$u\" $TOK) = 200 ] || exit 1; done )"
check "bookmarks returns the vault's bookmark" "curl -s -m 5 -H 'Authorization: Bearer $TOK' 'http://127.0.0.1:18794/api/bookmarks?vault=Demo' | grep -q Alpha.md"
kill $P; wait $P 2>/dev/null
cp $E $S/env-after-upgrade

echo "== T4: re-run the NEW installer again (must change nothing)"
( cd $S && setsid env HOME=$H XDG_CONFIG_HOME=$H/.config G2SIDIAN_DRYRUN=1 G2SIDIAN_SRC=$NEW bash $NEW/install.sh ) > $S/t4.log 2>&1
check "env identical after a second run" "diff -q $S/env-after-upgrade $E >/dev/null"

echo "== T1: NEW version, fresh install (local clone), no OpenAI key"
H2=$S/h-new; mkdir -p $H2; mkvault $S/vault-new
( cd $S && setsid env HOME=$H2 XDG_CONFIG_HOME=$H2/.config G2SIDIAN_DRYRUN=1 G2SIDIAN_API_PORT=18794 G2SIDIAN_SRC=$NEW \
  G2SIDIAN_VAULTS_OVERRIDE="[{\"name\":\"Demo\",\"path\":\"$S/vault-new/Demo\"}]" G2SIDIAN_OPENAI_KEY= bash $NEW/install.sh ) > $S/t1.log 2>&1
E2=$H2/.config/g2sidian.env; TOK2=$(sed -n 's/^G2SIDIAN_TOKEN=//p' $E2)
check "fresh new install exits OK" "grep -q 'backend is up' $S/t1.log"
check "fresh env: token+vaults+mode, no key, no date-format override" "grep -q '^G2SIDIAN_TOKEN=g2s_' $E2 && grep -q vault-new $E2 && grep -qx 'G2SIDIAN_CAPTURE_MODE=daily' $E2 && ! grep -q OPENAI_API_KEY $E2 && ! grep -q DAILY_FORMAT $E2"
check "paste-config blob printed" "grep -q 'g2sidian:ey' $S/t1.log"
P=$(backend $H2); PIDS+=($P); waitup
check "fresh new backend: health + recent 200, wrong token 401" "[ \$(code /api/health $TOK2) = 200 ] && [ \$(code '/api/recent?vault=Demo' $TOK2) = 200 ] && [ \$(code '/api/list?vault=Demo&path=' wrong) = 401 ]"
kill $P; wait $P 2>/dev/null
echo "== API contract (exact calls each app version makes)"
python3 $NEW/tests/test_api_contract.py $NEW old-app || FAIL=$((FAIL+1))
python3 $NEW/tests/test_api_contract.py $S/old new-app || FAIL=$((FAIL+1))
echo; echo "RESULT: $PASS install checks passed, $FAIL failed"; [ $FAIL = 0 ]
