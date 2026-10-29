# SNES Touch

A Super NES, Nintendo 64, PlayStation 2 and GameCube emulator for the browser with a multi-touch game controller, built for phones.

- **Emulation:** libretro cores (WebAssembly) driven by [Nostalgist.js](https://nostalgist.js.org/). SNES runs on snes9x (~1.2 MB, fetched from jsDelivr). N64 runs on mupen64plus_next, or parallel_n64 on iPhone and iPad, where EmulatorJS also avoids mupen64plus_next; both are [EmulatorJS](https://github.com/EmulatorJS/EmulatorJS) 4.2 builds (GPLv2, sources at [EmulatorJS/mupen64plus-libretro-nx](https://github.com/EmulatorJS/mupen64plus-libretro-nx) and [EmulatorJS/parallel-n64](https://github.com/EmulatorJS/parallel-n64)) served from `public/cores` (~2 MB each). Cores download on first use and the service worker caches them.
- **PS2:** [Play!](https://github.com/jpd002/Play-) (BSD-2-Clause), the web build from playjs.purei.org, in `public/cores/play-2026-10-26` with its licence. Experimental: Play!'s web port has no pause, reset or save states, its sticks are all-or-nothing, and it only reads pad 1. Memory cards are copied out of the emulator and kept per game.
- **GameCube:** [wasm-dolphin](https://github.com/dougchansan/wasm-dolphin) (Dolphin compiled to WebAssembly with a PowerPC-to-WASM JIT, GPLv2+, commit 7e38409), served from `public/gc` in a same-origin frame that the app drives through its `window.__host`. Two files are changed from upstream, marked `SNES Touch` (GPL): `src/upstream-worker-adapter.js` and `src/upstream-discio-worker.js` copy the memory card folder in and out (so in-game saves are kept per game) and set the speed (fast forward). Pause, restart, save states and analog sticks use the port's own controls. The core in `public/gc/cores/dolphin` is our rebuild: the stock one only answers controller port 1, ours adds `SetInputStateForPort` and plugs controllers into ports 2–4, so GameCube rooms take 4 players (`public/gc/SNES-TOUCH-CHANGES.patch` has the change and the build steps; the expected hash in `src/upstream-worker-protocol.js` is updated to match). Desktop Chrome only (1.5 GB of shared memory, 16 threads). It is validated on commercial discs (Melee first); homebrew discs and `.dol` files don't run in it. The app ships Dolphin's free replacement GameCube fonts (`public/gc/sys/GC`, Apache-2.0) and writes them in before boot, because the core only embeds `Sys/Wii` and games hang without them. Speed is limited by emulating the GameCube's CPU without a working JIT: Need for Speed: Underground 2 runs at about a quarter of real speed on an M2 Max (measured by its own race timer). Up to 8 raster threads help a little; underclocking the CPU only hides the slowdown. The JIT and its cache are off, because the JIT emits invalid WebAssembly in that game and the cached block brings the crash back on every load. Corresponding source: that repository at that commit, which pins Dolphin and its patches, plus the changed files and the patch here.
- **Disc games** (PS2 and GameCube images are gigabytes) aren't copied into the library: in Chrome and Edge the library keeps a handle to the file and asks once per visit before reading it; elsewhere, pick the file again each visit. `.iso` files are told apart by their header.
- PS2 and GameCube need threads, so the site sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (`vercel.json`).
- **N64 pad:** analog stick (full push near the rim, small dead zone), A, B, the four C buttons, Z, L, R and Start.
- **Touch controller (SNES):** D-pad that works like a stick once grabbed (8-way, narrower diagonals, dead zone), ABXY with slide-between and press-two-at-once in the gap between neighbours, L/R, Select/Start, haptic tick on press (Vibration API on Android, the `<input switch>` haptic on iOS 18+). Portrait layout below the screen; landscape overlays the sides.
- **Loading games:** "Load ROMs" takes one or many files (SNES .sfc, .smc, .fig, .swc; N64 .z64, .n64, .v64; or .zip, and every ROM inside a zip is added; PS2 .iso, .chd, .cso, .elf; GameCube .iso, .rvz, .gcm, .ciso), or drop them on the page on desktop. ROMs never leave the device.
- **Saves:** ROMs, battery saves (polled every 15 s and when the app is backgrounded), a manual save-state slot and an auto-resume state (every 60 s and on quit) live in IndexedDB on the device.
- **PWA:** installable, full screen from the home screen, works offline after the first visit.

- **Multiplayer:** 2 players for SNES games, up to 4 for N64 and GameCube (PS2 is single-player). The host opens the pause menu and taps **Invite player 2** (**Invite players** on N64), which copies the invite link (`/#join=ABCD`) to send to friends. Opening the link joins the game straight away as the next free player; a guest can also type the room code into **Join a game**. The host streams the screen and sound to each guest over WebRTC, and each guest's pad (stick included) comes back over a data channel. Guests don't need the ROM. Signaling goes through Supabase Realtime (`src/config.ts`); TURN relays come from the `snes-ice` edge function (below).

USB and Bluetooth controllers work through the browser's Gamepad API (`src/gamepads.ts`): the first pad is player 1, the next player 2, and so on (only the first one while friends are in the room). Buttons go by position. SNES: bottom = B, right = A, left = Y, top = X, bumpers or triggers = L/R, Back = Select, left stick or d-pad = d-pad. N64: left stick = stick, bottom = A, left (or right) = B, triggers = Z, bumpers = L/R, right stick = C buttons. Home, or Back + Start, opens the menu. Wired Xbox One/Series controllers that the system has no driver for (third-party ones like the Hyperkin X91 on a Mac) work in Chrome and Edge through **Connect USB controller**, which reads them over WebUSB (`src/usbpads.ts`); Chrome remembers the choice. Steam takes Xbox-style controllers for itself while it runs, so quit it first.

Keyboard also works. SNES: arrows, Z/X = B/A, A/S = Y/X, Q/W = L/R, Enter = Start, Right Shift = Select. N64: arrows = stick, X/Z = A/B, A = Z, Q/W = L/R, I/J/K/L = C buttons, Enter = Start. Esc opens the menu.

## Develop

```bash
npm install
npm run dev
```

`npm run build` type-checks and bundles to `dist/`. Deploys on Vercel as a static Vite site (`vercel.json` adds cache headers).

## Builds with bundled games

```bash
scripts/deploy-private.sh ~/Downloads/game.zip ~/Downloads/other.sfc
```

Builds the app with those ROMs in `/roms` (plus an `index.json`) and deploys that build with `vercel deploy --prebuilt --prod`. The first time a device opens the site, the games are copied into its library. A plain `vercel deploy --prod` afterwards replaces the build and drops the games. Without `--prod` on the script's last line you get a preview deployment instead, which Vercel Authentication keeps behind your Vercel login.

## Multiplayer relay (TURN)

Phones on cellular often can't connect to each other directly, so WebRTC needs a TURN relay. `supabase/functions/snes-ice` hands out ICE servers: STUN always, plus TURN when configured. Without it deployed the game falls back to STUN only, which works on many Wi-Fi networks.

1. Create a TURN key in the Cloudflare dashboard (Realtime → TURN). 1,000 GB/month are free.
2. Deploy the function and set its secrets:

```bash
supabase functions deploy snes-ice --project-ref ckrxlqxkfxgagsghoegr --no-verify-jwt
supabase secrets set --project-ref ckrxlqxkfxgagsghoegr CLOUDFLARE_TURN_KEY_ID=… CLOUDFLARE_TURN_KEY_API_TOKEN=…
```

Any other TURN server works too: set `TURN_URLS`, `TURN_USERNAME` and `TURN_CREDENTIAL` instead.

## Controller test ROM

`public/controller-test.sfc` is generated by `npm run test-rom` (`scripts/make-test-rom.mjs`, a tiny 65816 assembler + program). It draws the pad and lights each button while it is held, so input can be checked without a commercial ROM. Add `?debug` to the URL to expose `window.snesTouch.emulator` for scripted checks.

Icons are rendered by `scripts/make-icons.mjs`.

Only play games you own.
