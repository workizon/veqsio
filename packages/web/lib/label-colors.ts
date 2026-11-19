/**
 * Label colours: a 12 token palette that works in light and dark mode, plus optional custom hex.
 *
 * The CSS custom properties in app/globals.css (`--label-<token>-bg|fg|dot`, light and `.dark`) mirror
 * LABEL_PALETTE; tests/label-colors.test.ts checks that they stay in sync and that every chip passes
 * WCAG AA text contrast (4.5:1) in both themes. Colour is never the only signal: chips always show the
 * label name as text.
 */

export const LABEL_TOKENS = ['gray', 'red', 'orange', 'amber', 'lime', 'green', 'teal', 'cyan', 'blue', 'indigo', 'violet', 'pink'] as const
export type LabelToken = (typeof LABEL_TOKENS)[number]

export interface ChipColors {
  bg: string
  fg: string
  dot: string
}

export type Theme = 'light' | 'dark'

export const LABEL_PALETTE: Record<LabelToken, { light: ChipColors; dark: ChipColors; name: string }> = {
  gray: { name: 'Gray', light: { bg: '#EEF0F3', fg: '#3F4654', dot: '#6B7385' }, dark: { bg: '#2B303B', fg: '#C9CFDA', dot: '#8F98AB' } },
  red: { name: 'Red', light: { bg: '#FDE8E6', fg: '#A3261B', dot: '#D92D20' }, dark: { bg: '#4A1D1A', fg: '#FFB4AC', dot: '#F97066' } },
  orange: { name: 'Orange', light: { bg: '#FEEBD9', fg: '#9A4A07', dot: '#C25800' }, dark: { bg: '#4A2A0C', fg: '#FFC796', dot: '#F79B3E' } },
  amber: { name: 'Amber', light: { bg: '#FEF3C7', fg: '#7A5700', dot: '#9C6F00' }, dark: { bg: '#46380A', fg: '#F8DB7C', dot: '#EAB308' } },
  lime: { name: 'Lime', light: { bg: '#ECF7D0', fg: '#476808', dot: '#578508' }, dark: { bg: '#2E3F0E', fg: '#C9E68A', dot: '#9CCB3B' } },
  green: { name: 'Green', light: { bg: '#DDF5E8', fg: '#14693F', dot: '#11805A' }, dark: { bg: '#123E2A', fg: '#8FE3B6', dot: '#3CC98A' } },
  teal: { name: 'Teal', light: { bg: '#D5F5F0', fg: '#0F6B62', dot: '#0D8176' }, dark: { bg: '#0F3D39', fg: '#85E3D8', dot: '#2FC4B6' } },
  cyan: { name: 'Cyan', light: { bg: '#D6F1FA', fg: '#0B6178', dot: '#0A7F9E' }, dark: { bg: '#0E3B49', fg: '#8ADBF0', dot: '#34B7DA' } },
  blue: { name: 'Blue', light: { bg: '#E0E9FF', fg: '#2444B0', dot: '#3D6AF0' }, dark: { bg: '#1B2E6B', fg: '#AFC6FF', dot: '#6C8FFA' } },
  indigo: { name: 'Indigo', light: { bg: '#E8E7FF', fg: '#3F3BA8', dot: '#5B57E0' }, dark: { bg: '#2A2870', fg: '#C3C0FF', dot: '#8A86F5' } },
  violet: { name: 'Violet', light: { bg: '#F0E5FF', fg: '#6527B5', dot: '#8B46E0' }, dark: { bg: '#3A2170', fg: '#DDC2FF', dot: '#B27EF5' } },
  pink: { name: 'Pink', light: { bg: '#FCE4F1', fg: '#A21E63', dot: '#DB3F90' }, dark: { bg: '#4B1634', fg: '#FFB3D8', dot: '#F26FB0' } },
}

/** Neutral chip used for labels without a colour. */
export const DEFAULT_LABEL_TOKEN: LabelToken = 'gray'

const HEX_RE = /^#[0-9a-f]{6}$/i

export function isLabelToken(value: unknown): value is LabelToken {
  return typeof value === 'string' && (LABEL_TOKENS as readonly string[]).includes(value)
}

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_RE.test(value)
}

/* ------------------------------------------------------------------ */
/*  Colour maths (WCAG 2.x)                                            */
/* ------------------------------------------------------------------ */

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

function channel(v: number): number {
  const s = v / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/** Linear mix: t = 0 gives `a`, t = 1 gives `b`. */
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a)
  const [br, bg, bb] = hexToRgb(b)
  return rgbToHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t)
}

/** Moves `fg` towards `toward` (black or white) in small steps until it reaches `min` contrast on `bg`. */
export function ensureContrast(fg: string, bg: string, min: number, toward: '#000000' | '#ffffff'): string {
  let out = fg
  for (let i = 0; i <= 20 && contrastRatio(out, bg) < min; i++) {
    out = mix(fg, toward, (i + 1) / 20)
  }
  return out
}

const LIGHT_SURFACE = '#FFFFFF'
const DARK_SURFACE = '#10131A'

/** Chip colours for an arbitrary hex. Background is a tint of the hex, text is pushed until AA contrast holds. */
export function customChipColors(hex: string, theme: Theme): ChipColors {
  if (theme === 'light') {
    const bg = mix(hex, LIGHT_SURFACE, 0.86)
    return { bg, fg: ensureContrast(hex, bg, 4.5, '#000000'), dot: hex }
  }
  const bg = mix(hex, DARK_SURFACE, 0.72)
  return { bg, fg: ensureContrast(hex, bg, 4.5, '#ffffff'), dot: hex }
}

/** Resolves any stored label colour (token, hex or empty) to concrete chip colours for a theme. */
export function resolveChipColors(color: string | null | undefined, theme: Theme): ChipColors {
  if (isLabelToken(color)) return LABEL_PALETTE[color][theme]
  if (isHexColor(color)) return customChipColors(color.toLowerCase(), theme)
  return LABEL_PALETTE[DEFAULT_LABEL_TOKEN][theme]
}

/**
 * Chip presentation as a class plus inline CSS variables. Palette tokens are handled entirely by CSS
 * variables (so themes switch without JS); custom hex values ship both themes' colours inline.
 */
export function labelChipProps(color: string | null | undefined): { className: string; style?: Record<string, string>; custom: boolean } {
  if (isLabelToken(color)) return { className: `label-chip label-chip--${color}`, custom: false }
  if (isHexColor(color)) {
    const hex = color.toLowerCase()
    const l = customChipColors(hex, 'light')
    const d = customChipColors(hex, 'dark')
    return {
      className: 'label-chip label-chip--custom',
      custom: true,
      style: {
        '--lcx-bg': l.bg, '--lcx-fg': l.fg, '--lcx-dot': l.dot,
        '--lcx-bg-d': d.bg, '--lcx-fg-d': d.fg, '--lcx-dot-d': d.dot,
      },
    }
  }
  return { className: `label-chip label-chip--${DEFAULT_LABEL_TOKEN}`, custom: false }
}

/** Human description used for tooltips and screen readers, so the colour is never the only signal. */
export function describeLabel(name: string, color: string | null | undefined, removeOnResolve = false): string {
  const colourName = isLabelToken(color) ? LABEL_PALETTE[color].name.toLowerCase() : isHexColor(color) ? `custom colour ${color}` : null
  const parts = [name]
  if (colourName) parts.push(`(${colourName})`)
  if (removeOnResolve) parts.push('removed when the issue is resolved')
  return parts.join(' ')
}

/** CSS for the palette, generated from LABEL_PALETTE (used by the sync test and to regenerate globals.css). */
export function paletteCssVariables(theme: Theme): string {
  return LABEL_TOKENS.map((t) => {
    const c = LABEL_PALETTE[t][theme]
    return `    --label-${t}-bg: ${c.bg};\n    --label-${t}-fg: ${c.fg};\n    --label-${t}-dot: ${c.dot};`
  }).join('\n')
}
