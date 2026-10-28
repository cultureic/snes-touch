#!/usr/bin/env bash
# Deploys SNES Touch to production with your own cartridge ROMs baked in (copied into each
# device's library on first visit). PS2 and GameCube discs are too big to bundle: pick them
# in the app instead.
#
#   scripts/deploy-private.sh ~/Downloads/game.zip ~/Downloads/other.sfc ...
set -euo pipefail
[ $# -gt 0 ] || { echo "usage: $0 <ROM files: .zip .sfc .smc .fig .z64 .n64 .v64>" >&2; exit 1; }

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
# A prebuilt deployment ignores vercel.json, so its headers go in the build config: PS2 and
# GameCube need cross-origin isolation (threads), and the cores and assets are immutable.
cat >"$out/config.json" <<'JSON'
{
  "version": 3,
  "routes": [
    {
      "src": "/(.*)",
      "headers": { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" },
      "continue": true
    },
    { "src": "/(assets|cores)/(.*)", "headers": { "Cache-Control": "public, max-age=31536000, immutable" }, "continue": true },
    { "src": "/sw.js", "headers": { "Cache-Control": "no-cache" }, "continue": true }
  ]
}
JSON

vercel deploy --prebuilt --prod --yes
