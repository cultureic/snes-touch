// Copies Dolphin's per-game settings (Data/Sys/GameSettings) into public/gc/sys/GameSettings
// and lists them in index.json, from which the GameCube worker picks the files named after the
// disc it boots. Copy them from the Dolphin source the GameCube core was built from:
//
//   node scripts/copy-dolphin-game-settings.mjs ~/path/to/dolphin
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [dolphin] = process.argv.slice(2)
if (!dolphin) {
  console.error('usage: node scripts/copy-dolphin-game-settings.mjs <Dolphin source folder>')
  process.exit(1)
}
const from = join(dolphin, 'Data/Sys/GameSettings')
const to = fileURLToPath(new URL('../public/gc/sys/GameSettings/', import.meta.url))
const names = readdirSync(from).filter((name) => name.endsWith('.ini')).sort()

rmSync(to, { recursive: true, force: true })
mkdirSync(to, { recursive: true })
for (const name of names) copyFileSync(join(from, name), join(to, name))
writeFileSync(join(to, 'index.json'), JSON.stringify(names, null, 1) + '\n')
console.log(`${names.length} settings files copied to ${to}`)
