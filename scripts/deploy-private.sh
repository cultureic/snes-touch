#!/usr/bin/env bash
# Deploys SNES Touch with your own ROMs baked in, as a *preview* deployment. Vercel
# Authentication keeps preview URLs behind your Vercel login, and this never deploys
# to production, so the public site stays ROM-free.
#
#   scripts/deploy-private.sh ~/Downloads/game.zip ~/Downloads/other.sfc ...
set -euo pipefail
[ $# -gt 0 ] || { echo "usage: $0 <ROM files: .zip .sfc .smc .fig>" >&2; exit 1; }

roms=()
for rom in "$@"; do roms+=("$(cd "$(dirname "$rom")" && pwd)/$(basename "$rom")"); done
cd "$(dirname "$0")/.."

out=.vercel/output
trap 'rm -rf "$out"' EXIT # never leave ROMs lying in the project
rm -rf "$out"
npx vite build --outDir "$out/static" --emptyOutDir >/dev/null
mkdir -p "$out/static/roms"
cp "${roms[@]}" "$out/static/roms/"
node -e '
  const fs = require("fs"), dir = process.argv[1]
  fs.writeFileSync(`${dir}/index.json`, JSON.stringify(fs.readdirSync(dir).filter((f) => f !== "index.json")))
' "$out/static/roms"
echo '{ "version": 3 }' >"$out/config.json"

vercel deploy --prebuilt --prod --yes
