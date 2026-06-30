#!/usr/bin/env bash
# Gbsidian backend installer — one command to stand up the control plane on YOUR machine.
#
#   curl -fsSL https://raw.githubusercontent.com/liyiyuian/g2sidian/main/install.sh | bash
#
# It: checks prereqs, downloads the backend, generates a token, auto-discovers your Obsidian
# vaults, writes the env file, installs a systemd --user service, exposes it tailnet-only over
# HTTPS, and prints the Backend URL + token + a paste-config blob for the glasses app.
#
# This backend reads/writes your Obsidian notes — it is loopback-bound + token-required +
# tailnet-only. Never expose it publicly or share the token.
#
# Testing hooks (not for normal use):
#   G2SIDIAN_SRC=/path/to/repo   copy backend files from a local dir instead of curl
#   G2SIDIAN_DRYRUN=1            don't touch systemd/tailscale/sudo (print instead)
#   G2SIDIAN_VAULTS_OVERRIDE=…   supply the G2SIDIAN_VAULTS JSON non-interactively
#   G2SIDIAN_OPENAI_KEY=sk-...   supply the OpenAI key non-interactively ("" = skip voice)
set -euo pipefail

REPO="${G2SIDIAN_REPO:-liyiyuian/g2sidian}"
RAW="https://raw.githubusercontent.com/${REPO}/main"
PORT="${G2SIDIAN_API_PORT:-8793}"
HTTPS_PORT="${G2SIDIAN_HTTPS_PORT:-8445}"   # distinct serve mount (tmuxor owns the :443 root)
INSTALL_DIR="${G2SIDIAN_DIR:-$HOME/.local/share/g2sidian}"
ENV_FILE="${G2SIDIAN_ENV:-$HOME/.config/g2sidian.env}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
DRY="${G2SIDIAN_DRYRUN:-0}"

c()  { printf '\033[36m%s\033[0m\n' "$*"; }
ok() { printf '\033[32m✓ %s\033[0m\n' "$*"; }
warn(){ printf '\033[33m! %s\033[0m\n' "$*"; }
die(){ printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
run(){ if [ "$DRY" = 1 ]; then echo "  [dry-run] $*"; else "$@"; fi; }

c "Gbsidian backend installer"

# 1) prerequisites -----------------------------------------------------------
command -v python3 >/dev/null || die "python3 not found (need 3.10+). Install Python first."
PYV=$(python3 -c 'import sys;print("%d.%d"%sys.version_info[:2])')
python3 -c 'import sys;exit(0 if sys.version_info[:2]>=(3,10) else 1)' || die "python3 $PYV too old; need 3.10+."
ok "python3 $PYV"
command -v tailscale >/dev/null && ok "tailscale" || die "tailscale not found. Install + log in: https://tailscale.com/download"

# 2) download backend --------------------------------------------------------
# Run from a clone? use the local files automatically (no re-download).
[ -z "${G2SIDIAN_SRC:-}" ] && [ -f g2sidian_api.py ] && G2SIDIAN_SRC="$(pwd)"
mkdir -p "$INSTALL_DIR"
for f in g2sidian_api.py md_flatten.py vault_query.py; do
  if [ -n "${G2SIDIAN_SRC:-}" ]; then cp "$G2SIDIAN_SRC/$f" "$INSTALL_DIR/$f"
  else curl -fsSL "$RAW/$f" -o "$INSTALL_DIR/$f" || die "could not download $f from $RAW"; fi
done
ok "backend in $INSTALL_DIR"

# 3) token (reuse existing if present) ---------------------------------------
TOKEN=""
[ -f "$ENV_FILE" ] && TOKEN=$(sed -n 's/^G2SIDIAN_TOKEN=//p' "$ENV_FILE" | head -1)
if [ -z "$TOKEN" ]; then TOKEN="g2s_$(python3 -c 'import secrets;print(secrets.token_urlsafe(24))')"; ok "generated a new access token"
else ok "reusing existing access token"; fi

# 4) discover Obsidian vaults (.obsidian dir => its parent is a vault) --------
if [ -n "${G2SIDIAN_VAULTS_OVERRIDE:-}" ]; then
  VAULTS_JSON="$G2SIDIAN_VAULTS_OVERRIDE"
else
  mapfile -t FOUND < <(find "$HOME/Documents" "$HOME/Obsidian" "$HOME" -maxdepth 4 -type d -name .obsidian 2>/dev/null \
    | sed 's#/\.obsidian$##' | sort -u)
  [ "${#FOUND[@]}" -gt 0 ] || warn "no Obsidian vaults auto-found — edit G2SIDIAN_VAULTS in $ENV_FILE by hand."
  VAULTS_JSON=$(python3 - "${FOUND[@]}" <<'PY'
import json,os,sys
seen={}; out=[]
for p in sys.argv[1:]:
    if not p: continue
    base=os.path.basename(p.rstrip('/')); name=base; i=2
    while name in seen: name=f"{base}-{i}"; i+=1
    seen[name]=1; out.append({"name":name,"path":p})
print(json.dumps(out))
PY
)
  c "discovered vaults:"; python3 -c 'import json,sys;[print("   ",v["name"],"=>",v["path"]) for v in json.loads(sys.argv[1])]' "$VAULTS_JSON"
fi

# 5) OpenAI key (OPTIONAL) — enables VOICE capture; without it you type on your phone --------
if [ "${G2SIDIAN_OPENAI_KEY+set}" = set ]; then OPENAI_KEY="$G2SIDIAN_OPENAI_KEY"
elif [ -r /dev/tty ]; then
  printf 'OpenAI API key (optional) — enables VOICE capture via Whisper; without it you type on your phone. Paste it, or Enter to skip: '
  read -r OPENAI_KEY </dev/tty || OPENAI_KEY=""
else OPENAI_KEY=""; fi
[ -n "$OPENAI_KEY" ] && ok "voice capture enabled" || warn "no OpenAI key — voice off; you'll type notes on your phone (re-run later to add voice)."

# 6) write env file (chmod 600) ---------------------------------------------
mkdir -p "$(dirname "$ENV_FILE")"; umask 177
{
  echo "G2SIDIAN_TOKEN=$TOKEN"
  echo "G2SIDIAN_BIND=127.0.0.1"
  echo "G2SIDIAN_API_PORT=$PORT"
  echo "G2SIDIAN_VAULTS=$VAULTS_JSON"
  echo "G2SIDIAN_CAPTURE_MODE=daily"   # voice quick-capture target: daily | inbox
  echo "G2SIDIAN_DAILY_FORMAT=%Y-%m-%d"
  # G2SIDIAN_CAPTURE_VAULT=<name>      # which vault quick-capture writes to (default: first)
  # G2SIDIAN_INBOX_PATH=Inbox.md       # used when G2SIDIAN_CAPTURE_MODE=inbox
  [ -n "$OPENAI_KEY" ] && echo "OPENAI_API_KEY=$OPENAI_KEY"
} > "$ENV_FILE"
umask 022; chmod 600 "$ENV_FILE"
ok "wrote $ENV_FILE"

# 7) systemd --user service --------------------------------------------------
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/g2sidian.service" <<UNIT
[Unit]
Description=Gbsidian backend (Obsidian-over-Tailscale control plane)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v python3) $INSTALL_DIR/g2sidian_api.py
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
UNIT
ok "wrote service unit"
run systemctl --user daemon-reload
run systemctl --user enable --now g2sidian.service
[ "$DRY" = 1 ] || warn "to keep it running after logout: sudo loginctl enable-linger $USER"

# 8) expose on the tailnet (distinct HTTPS mount; tmuxor owns the :443 root) --
run sudo tailscale set --operator="$USER"
run sudo tailscale serve --bg --https="$HTTPS_PORT" "$PORT"

# 9) resolve the tailnet URL -------------------------------------------------
DNS=$(tailscale status --json 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)
URL="https://${DNS:-<your-tailscale-host>.ts.net}:${HTTPS_PORT}"

# 10) build the glasses .ehpk with YOUR domain baked into the whitelist ------
#     (only when run from a clone with npm available — the curl|bash flow skips it)
EHPK=""
if [ -d glasses ] && command -v npm >/dev/null && [ -n "$DNS" ]; then
  c "Building the glasses app — baking your backend ($URL) into the whitelist…"
  if [ "$DRY" = 1 ]; then
    echo "  [dry-run] cp app.json.example→app.json, inject whitelist, npm install && npm run build, pack .ehpk"
  else
    ( cd glasses
      [ -f app.json ] || cp app.json.example app.json
      python3 - "$URL" <<'PY'
import json, sys
d = json.load(open("app.json"))
for perm in d.get("permissions", []):
    if perm.get("name") == "network":
        perm["whitelist"] = [sys.argv[1]]
json.dump(d, open("app.json", "w"), indent=2)
PY
      npm install --silent >/dev/null 2>&1 || exit 1
      bash build.sh >/dev/null 2>&1 || exit 1   # build + URL-allowlist guard (Even review) + pack
    ) && EHPK="glasses/Gbsidian-$(python3 -c 'import json;print(json.load(open("glasses/app.json"))["version"])').ehpk"
    [ -n "$EHPK" ] && [ -f "$EHPK" ] && ok "built $EHPK" || { warn "glasses build hit a snag — build it manually (see README)."; EHPK=""; }
  fi
else
  warn "skipped the glasses .ehpk build (need a clone + npm + a Tailscale domain). See the README to build it."
fi

# 11) summary + paste-config -------------------------------------------------
BLOB="g2sidian:$(python3 -c 'import base64,json,sys;print(base64.urlsafe_b64encode(json.dumps({"base":sys.argv[1],"token":sys.argv[2]}).encode()).decode())' "$URL" "$TOKEN")"

echo
ok "Gbsidian backend is up."
c  "Backend URL : $URL"
c  "Token       : $TOKEN"
[ -n "$EHPK" ] && c "Glasses app : $EHPK   (install via QR sideload, or upload as a Hub Private build)"
echo
c  "On your phone: open Gbsidian → Setup → 'Paste config'. Paste this line:"
echo "  $BLOB"
if command -v qrencode >/dev/null; then
  echo; c "(or scan this QR with your phone's camera to copy the code, then paste it)"
  qrencode -t ANSIUTF8 "$BLOB"
fi
echo
[ -z "$DNS" ] && warn "couldn't read your Tailscale domain — run 'tailscale status' and use https://<host>.ts.net:${HTTPS_PORT}."
