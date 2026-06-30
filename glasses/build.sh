#!/usr/bin/env bash
# Build the Gbsidian .ehpk (PUBLIC build — no token/key baked; the backend URL + token are entered
# in the phone Setup at runtime). Runs an Even-review guard before packing.
set -euo pipefail
cd "$(dirname "$0")"
VER=$(python3 -c "import json;print(json.load(open('app.json'))['version'])")
NAME=$(python3 -c "import json;print(json.load(open('app.json'))['name'])")

echo "==> building $NAME $VER"
npm run build

# URL allowlist guard: Even's review rejects ANY bundled URL not in network.whitelist (this is what
# silently reverts a submission). The bundle may contain ONLY the whitelisted backend origin plus
# standard non-network library strings (W3C XML/SVG namespaces, the localhost URL-parser base).
# Anything else (React/router doc links, stray endpoints, placeholders) must be stripped (vite
# renderChunk) or whitelisted in app.json — fail loudly here so it never reaches review.
BACKEND=$(python3 -c "import json;print(json.load(open('app.json'))['permissions'][0]['whitelist'][0])")
BAD=$(grep -rhoE 'https?://[^"'"'"' )<>`}]+' dist | sort -u \
  | grep -vF "$BACKEND" \
  | grep -vE '^http://localhost' \
  | grep -vE '^http://www\.w3\.org/' || true)
if [ -n "$BAD" ]; then
  echo "!! bundle contains URL(s) not covered by network.whitelist:"; echo "$BAD"
  echo "   strip them (vite renderChunk) or whitelist them in app.json — aborting"; exit 1
fi

# Secret safety net: a public build must bake no token/key.
if grep -rqE 'pcx_[A-Za-z0-9]|g2s_[A-Za-z0-9]{10}|sk-[A-Za-z0-9]{15}' dist; then
  echo "!! a secret leaked into the bundle — aborting"; exit 1
fi

npx @evenrealities/evenhub-cli@latest pack app.json dist -o "${NAME}-${VER}.ehpk"
echo "==> done: ${NAME}-${VER}.ehpk  (review-guarded; no secrets)"
