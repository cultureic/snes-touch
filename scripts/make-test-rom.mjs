// Builds public/controller-test.sfc: a 64 KiB LoROM program that draws the SNES
// pad and lights up each button while it is held, so the touch controller can be
// checked end to end without a commercial ROM. Player 2's pad lights the same
// buttons plus a purple lamp at the top, for checking multiplayer input. The 65816
// code is assembled by the tiny assembler below, so no SNES toolchain is needed.
import { writeFileSync } from 'node:fs'

const ROM_SIZE = 0x10000
const ORIGIN = 0x8000 // CPU address of file offset 0 (bank $00)
const HEADER = 0x7fc0 // file offset of the LoROM header ($00:FFC0)
const BUFFER = 0x0800 // WRAM copy of the BG1 tilemap, DMA'd to VRAM every frame
const TILEMAP_VRAM = 0x1000 // word address of the BG1 tilemap
const MAP_BYTES = 28 * 32 * 2 // the 28 visible rows of a 32x32 map

// ---------------------------------------------------------------- assembler

const rom = new Uint8Array(ROM_SIZE)
const labels = new Map()
const fixups = []
let pc = ORIGIN

const byte = (...values) => {
  for (const value of values) rom[pc++ - ORIGIN] = value & 0xff
}
const word = (value) => byte(value, value >> 8)
const label = (name) => labels.set(name, pc)
// 16-bit operand: a number, or a label (+ offset) resolved at the end
const operand = (value, offset = 0) => {
  if (typeof value === 'number') return word(value)
  fixups.push({ at: pc, name: value, offset, relative: false })
  word(0)
}
const branch = (opcode, name) => {
  byte(opcode)
  fixups.push({ at: pc, name, relative: true })
  byte(0)
}

const SEI = () => byte(0x78)
const CLC = () => byte(0x18)
const XCE = () => byte(0xfb)
const REP = (bits) => byte(0xc2, bits)
const SEP = (bits) => byte(0xe2, bits)
const TXS = () => byte(0x9a)
const TCD = () => byte(0x5b)
const TYA = () => byte(0x98)
const TAY = () => byte(0xa8)
const INX = () => byte(0xe8)
const DEY = () => byte(0x88)
const WAI = () => byte(0xcb)
const RTI = () => byte(0x40)
const PHA = () => byte(0x48)
const PHX = () => byte(0xda)
const PHY = () => byte(0x5a)
const PLA = () => byte(0x68)
const PLX = () => byte(0xfa)
const PLY = () => byte(0x7a)
const LDA8 = (value) => byte(0xa9, value) // A is 8-bit
const LDA16 = (value) => (byte(0xa9), word(value)) // A is 16-bit
const LDX16 = (value) => (byte(0xa2), operand(value))
const LDY16 = (value) => (byte(0xa0), word(value))
const CPX16 = (value) => (byte(0xe0), word(value))
const AND16 = (value) => (byte(0x29), word(value))
const ORA16 = (value) => (byte(0x09), word(value))
const ADC16 = (value) => (byte(0x69), word(value))
const LDA_abs = (address) => (byte(0xad), word(address))
const LDA_absX = (name) => (byte(0xbd), operand(name))
const LDA_absY = (name, offset) => (byte(0xb9), operand(name, offset))
const STA_abs = (address) => (byte(0x8d), word(address))
const STA_absX = (address) => (byte(0x9d), word(address))
const STX_abs = (address) => (byte(0x8e), word(address))
const STZ_abs = (address) => (byte(0x9c), word(address))
const LDA_dp = (address) => byte(0xa5, address)
const STA_dp = (address) => byte(0x85, address)
const LDX_dp = (address) => byte(0xa6, address)
const AND_dp = (address) => byte(0x25, address)
const ORA_dp = (address) => byte(0x05, address)
const DEC_dp = (address) => byte(0xc6, address)
const BNE = (name) => branch(0xd0, name)
const BEQ = (name) => branch(0xf0, name)
const BRA = (name) => branch(0x80, name)

// ---------------------------------------------------------------- data

const bgr15 = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) >> 3)
  return r | (g << 5) | (b << 10)
}

// Mode 0 BG1 palettes: index 0 is the backdrop, color 1 of each palette is a button color.
const PALETTES = {
  backdrop: '#15131c',
  off: '#3a3648', // palette 0
  dpad: '#f2f0f7', // palette 1
  a: '#e5483f', // palette 2
  b: '#f2c230', // palette 3
  x: '#3f74e0', // palette 4
  y: '#2fae58', // palette 5
  meta: '#c9c4d6', // palette 6
  p2: '#8b7cf6', // palette 7
}
const PALETTE_INDEX = { dpad: 1, a: 2, b: 3, x: 4, y: 5, meta: 6, p2: 7 }

const cgram = new Array(32).fill(0)
cgram[0] = bgr15(PALETTES.backdrop)
cgram[1] = bgr15(PALETTES.off)
for (const [name, palette] of Object.entries(PALETTE_INDEX)) cgram[palette * 4 + 1] = bgr15(PALETTES[name])

// JOY1 bits as read from $4218/$4219, the color they light up, and the tile rect they own.
const BUTTONS = [
  // mask,  color,  col, row, w, h
  [0x0020, 'meta', 2, 3, 6, 2], // L
  [0x0010, 'meta', 24, 3, 6, 2], // R
  [0x0800, 'dpad', 6, 9, 3, 3], // Up
  [0x0400, 'dpad', 6, 15, 3, 3], // Down
  [0x0200, 'dpad', 3, 12, 3, 3], // Left
  [0x0100, 'dpad', 9, 12, 3, 3], // Right
  [0x0001, 'dpad', 6, 12, 3, 3], // d-pad hub: a signature bit that is never set
  [0x0040, 'x', 23, 9, 3, 3], // X
  [0x8000, 'b', 23, 15, 3, 3], // B
  [0x4000, 'y', 20, 12, 3, 3], // Y
  [0x0080, 'a', 26, 12, 3, 3], // A
  [0x2000, 'meta', 10, 21, 5, 2], // Select
  [0x1000, 'meta', 17, 21, 5, 2], // Start
  [0x0002, 'p2', 14, 0, 4, 2], // player 2 lamp: another signature bit, set by the code below
]
const SOLID_TILE = 1
const OFF_ENTRY = SOLID_TILE // palette 0

// ---------------------------------------------------------------- program

// Direct page variables (16-bit)
const JOY = 0x00
const ENTRY = 0x02
const PTR = 0x04
const ROWS = 0x06
const COLS = 0x08

label('reset')
SEI()
CLC()
XCE() // native mode
REP(0x38) // 16-bit A/X/Y, binary arithmetic
LDX16(0x1fff)
TXS()
LDA16(0x0000)
TCD()
SEP(0x20) // 8-bit A, 16-bit X/Y

LDA8(0x8f)
STA_abs(0x2100) // forced blank
STZ_abs(0x4200) // no NMI or auto-joypad yet
STZ_abs(0x420c) // no HDMA
STZ_abs(0x2105) // BG mode 0
LDA8((TILEMAP_VRAM >> 10) << 2)
STA_abs(0x2107) // BG1 tilemap, 32x32
STZ_abs(0x210b) // BG1 tiles at VRAM $0000
STZ_abs(0x210d)
STZ_abs(0x210d) // BG1 horizontal scroll = 0
LDA8(0xff)
STA_abs(0x210e)
STZ_abs(0x210e) // BG1 vertical scroll = -1, so map row 0 is the top line
LDA8(0x01)
STA_abs(0x212c) // BG1 on the main screen
STZ_abs(0x212d)
STZ_abs(0x2130)
STZ_abs(0x2131) // no color math
STZ_abs(0x2133)
LDA8(0x80)
STA_abs(0x2115) // VRAM address increments after the high byte

// Clear all 64 KiB of VRAM with a fixed-source DMA of one zero byte.
LDX16(0x0000)
STX_abs(0x2116)
LDA8(0x09)
STA_abs(0x4300) // A->B, fixed source, two registers
LDA8(0x18)
STA_abs(0x4301) // $2118/$2119
LDX16('zero')
STX_abs(0x4302)
STZ_abs(0x4304)
LDX16(0x0000)
STX_abs(0x4305) // 0 = 65536 bytes
LDA8(0x01)
STA_abs(0x420b)

// Tile 1: solid color 1 (2bpp rows are plane0 = $FF, plane1 = $00).
LDX16(SOLID_TILE * 8)
STX_abs(0x2116)
LDY16(8)
LDX16(0x00ff)
label('tile')
STX_abs(0x2118)
DEY()
BNE('tile')

// Palettes
STZ_abs(0x2121)
LDX16(0x0000)
label('palette-loop')
LDA_absX('palette')
STA_abs(0x2122)
INX()
CPX16(cgram.length * 2)
BNE('palette-loop')

// Empty tilemap buffer
REP(0x20)
LDA16(0x0000)
LDX16(0x0000)
label('clear')
STA_absX(BUFFER)
INX()
INX()
CPX16(0x0800)
BNE('clear')

SEP(0x20)
LDA8(0x0f)
STA_abs(0x2100) // display on, full brightness
LDA8(0x81)
STA_abs(0x4200) // NMI + auto-joypad read
REP(0x20) // 16-bit A from here on

label('frame')
WAI() // the NMI handler uploads last frame's buffer
label('joypad-wait')
LDA_abs(0x4212)
AND16(0x0001) // auto-joypad read still running?
BNE('joypad-wait')
LDA_abs(0x4218)
STA_dp(JOY)
LDA_abs(0x421a) // player 2
BEQ('solo')
ORA16(0x0002) // mark "player 2 is pressing something" for the lamp
label('solo')
ORA_dp(JOY)
STA_dp(JOY) // both pads light the same layout
LDY16(0x0000)

label('button')
LDA_absY('buttons', 0) // mask; 0 ends the table
BEQ('frame')
AND_dp(JOY)
BEQ('released')
LDA_absY('buttons', 2) // lit tilemap entry
BRA('fill')
label('released')
LDA16(OFF_ENTRY)
label('fill')
STA_dp(ENTRY)
LDA_absY('buttons', 4)
STA_dp(PTR) // buffer address of the rect's top-left tile
LDA_absY('buttons', 8)
STA_dp(ROWS)
label('row')
LDX_dp(PTR)
LDA_absY('buttons', 6)
STA_dp(COLS)
LDA_dp(ENTRY)
label('column')
STA_absX(0x0000)
INX()
INX()
DEC_dp(COLS)
BNE('column')
LDA_dp(PTR)
CLC()
ADC16(64) // next tilemap row
STA_dp(PTR)
DEC_dp(ROWS)
BNE('row')
TYA()
CLC()
ADC16(10) // next table entry
TAY()
BRA('button')

label('nmi')
REP(0x30)
PHA()
PHX()
PHY()
SEP(0x20)
LDA_abs(0x4210) // acknowledge NMI
LDX16(TILEMAP_VRAM)
STX_abs(0x2116)
LDA8(0x01)
STA_abs(0x4300) // A->B, incrementing source, two registers
LDA8(0x18)
STA_abs(0x4301)
LDX16(BUFFER)
STX_abs(0x4302)
STZ_abs(0x4304)
LDX16(MAP_BYTES)
STX_abs(0x4305)
LDA8(0x01)
STA_abs(0x420b)
REP(0x30)
PLY()
PLX()
PLA()
label('ignore')
RTI()

label('zero')
byte(0)
label('palette')
for (const color of cgram) word(color)
label('buttons')
for (const [mask, color, col, row, width, height] of BUTTONS) {
  word(mask)
  word(SOLID_TILE | (PALETTE_INDEX[color] << 10))
  word(BUFFER + (row * 32 + col) * 2)
  word(width)
  word(height)
}
word(0)

if (pc - ORIGIN > HEADER) throw new Error('program overlaps the header')

for (const fixup of fixups) {
  const target = labels.get(fixup.name)
  if (target === undefined) throw new Error(`unknown label ${fixup.name}`)
  const at = fixup.at - ORIGIN
  if (fixup.relative) {
    const distance = target - (fixup.at + 1)
    if (distance < -128 || distance > 127) throw new Error(`branch to ${fixup.name} is out of range`)
    rom[at] = distance & 0xff
  } else {
    const value = target + fixup.offset
    rom[at] = value & 0xff
    rom[at + 1] = value >> 8
  }
}

// ---------------------------------------------------------------- header

const header = (offset, ...values) => rom.set(values, HEADER + offset)
const vector = (address, name) => {
  const target = labels.get(name)
  rom[address - ORIGIN] = target & 0xff
  rom[address - ORIGIN + 1] = target >> 8
}

header(0x00, ...Buffer.from('SNES TOUCH PAD TEST'.padEnd(21, ' '), 'ascii'))
header(0x15, 0x20) // LoROM, SlowROM
header(0x16, 0x02) // ROM + RAM + battery, so the app's save-RAM path gets exercised
header(0x17, 0x06) // 64 KiB ROM
header(0x18, 0x01) // 2 KiB SRAM
header(0x19, 0x01) // North America
header(0x1a, 0x00)
header(0x1b, 0x00) // version 1.0
header(0x1c, 0xff, 0xff, 0x00, 0x00) // checksum placeholder (complement, checksum)

for (const address of [0xffe4, 0xffe6, 0xffe8, 0xffee, 0xfff4, 0xfff8, 0xfffa, 0xfffe]) vector(address, 'ignore')
vector(0xffea, 'nmi')
vector(0xfffc, 'reset')

const checksum = rom.reduce((sum, value) => (sum + value) & 0xffff, 0)
header(0x1c, ~checksum & 0xff, (~checksum >> 8) & 0xff, checksum & 0xff, checksum >> 8)

const out = new URL('../public/controller-test.sfc', import.meta.url)
writeFileSync(out, rom)
console.log(`wrote ${out.pathname} (${pc - ORIGIN} bytes of code and data, checksum $${checksum.toString(16)})`)
