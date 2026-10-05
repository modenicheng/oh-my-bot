import { hash32 } from './lib/hash'

// 固定字形只改变笔画内字符：保持标题可读，而非整屏随机闪烁。
const GLYPHS: Record<string, string[]> = {
  O: ['01110', '11011', '11011', '11011', '11011', '11011', '01110'],
  H: ['11011', '11011', '11011', '11111', '11011', '11011', '11011'],
  M: ['10001', '11011', '11111', '10101', '10001', '10001', '10001'],
  Y: ['11011', '11011', '11011', '01110', '00100', '00100', '00100'],
  B: ['11110', '11011', '11011', '11110', '11011', '11011', '11110'],
  T: ['11111', '11111', '00100', '00100', '00100', '00100', '00100'],
  ' ': Array(7).fill('000'),
}
const mask = Array.from({ length: 7 }, (_, row) => [...'OH MY BOT']
  .map(letter => GLYPHS[letter]![row]!).join('0')
  .split('').map(cell => cell.repeat(2)).join(''))
  .flatMap(row => [row, row])
const INK = '#%+=*#'

/** Erased cells never reappear; the original spacing stays intact. */
export function erodeText(text: string, progress: number, seed = 0): string {
  const debris = '#*+:.'
  return Array.from(text, (char, index) => {
    if (/\s/.test(char) || progress <= 0) return char
    const hash = hash32(index + 1 + seed)
    const start = (hash % 997) / 997 * 0.58
    const age = (progress - start) / 0.3
    if (age <= 0) return char
    if (age >= 1) return ' '
    return debris[Math.min(debris.length - 1, Math.floor(age * debris.length))]!
  }).join('')
}

export function asciiTitle(frame: number): string {
  return mask.map((row, y) => [...row].map((cell, x) => {
    if (cell === '0') return ' '
    const wave = Math.floor(x / 5 + y / 3 - frame / 2)
    return INK[((wave % INK.length) + INK.length) % INK.length]
  }).join('')).join(String.fromCharCode(10))
}

export function asciiField(frame: number, columns: number, rows: number): string {
  return Array.from({ length: rows }, (_, y) => Array.from({ length: columns }, (_, x) => {
    const seed = (x * 73 + y * 37) % 97
    if (seed > 7) return ' '
    return '.:+*'[Math.floor((frame / 5 + seed + y) % 4)]
  }).join('')).join(String.fromCharCode(10))
}
