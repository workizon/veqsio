import { contrastRatio, ensureContrast, isHexColor, mix } from './label-colors'
import { trNow } from './tr'

/** Pure helpers for custom branding and the product footer (unit-tested, no React). */

export { isHexColor, contrastRatio }

export const MIN_ACCENT_CONTRAST = 3
export const MAX_LOGO_BYTES = 512 * 1024
export const DEFAULT_SITE_NAME = 'Veqsio'
export const DEFAULT_SOURCE_URL = 'https://github.com/workizon/veqsio'
/** Documentation and API reference live on the product website, not in the repository. */
export const DEFAULT_DOCS_URL = 'https://veqsio.com/docs'
export const DEFAULT_API_DOCS_URL = 'https://veqsio.com/docs/integrations-api'

export interface Branding {
  siteName: string
  logoLightUrl: string | null
  logoDarkUrl: string | null
  faviconUrl: string | null
  accentColor: string | null
  supportUrl: string | null
  docsUrl: string | null
  hideCredit: boolean
  sourceUrl: string
}

export const DEFAULT_BRANDING: Branding = {
  siteName: DEFAULT_SITE_NAME, logoLightUrl: null, logoDarkUrl: null, faviconUrl: null, accentColor: null,
  supportUrl: null, docsUrl: null, hideCredit: false, sourceUrl: DEFAULT_SOURCE_URL,
}

/** Null when the accent colour is acceptable, otherwise the reason (same rule as the server: at least 3:1 on white). */
export function checkAccent(value: string): string | null {
  if (!isHexColor(value)) return trNow('Use a hex colour like #3D6AF0')
  const r = contrastRatio(value, '#FFFFFF')
  if (r < MIN_ACCENT_CONTRAST) return trNow('Too light: contrast on white is {ratio}:1, at least {min}:1 is needed', { ratio: r.toFixed(1), min: MIN_ACCENT_CONTRAST })
  return null
}

const STEPS_LIGHT: Array<[number, string, number]> = [
  [50, '#FFFFFF', 0.92], [100, '#FFFFFF', 0.84], [200, '#FFFFFF', 0.7], [300, '#FFFFFF', 0.5], [400, '#FFFFFF', 0.25],
  [700, '#000000', 0.22], [800, '#000000', 0.4], [900, '#000000', 0.55],
]

/** The --brand-* (and button) tokens for an accent colour, for light and dark themes. */
export function accentTokens(accent: string): { light: Record<string, string>; dark: Record<string, string> } {
  const base = accent.toUpperCase()
  const light: Record<string, string> = { '--brand-500': base }
  for (const [n, to, t] of STEPS_LIGHT) light[`--brand-${n}`] = mix(base, to, t).toUpperCase()
  light['--brand-600'] = mix(base, '#000000', 0.1).toUpperCase()
  // Text on a filled button is white: keep at least 4.5:1.
  const button = ensureContrast(base, '#FFFFFF', 4.5, '#000000').toUpperCase()
  light['--button-primary'] = button
  light['--button-primary-hover'] = mix(button, '#000000', 0.18).toUpperCase()

  // Dark theme: the accent is lightened until it reads on the dark surface; tints are the accent mixed into graphite.
  const surface = '#1B1C1E'
  const vivid = ensureContrast(base, surface, 4.5, '#ffffff').toUpperCase()
  const dark: Record<string, string> = {
    '--brand-50': mix(surface, base, 0.12), '--brand-100': mix(surface, base, 0.2), '--brand-200': mix(surface, base, 0.3),
    '--brand-300': mix(surface, base, 0.45), '--brand-400': mix(surface, base, 0.7),
    '--brand-500': vivid, '--brand-600': mix(vivid, '#FFFFFF', 0.12), '--brand-700': mix(vivid, '#FFFFFF', 0.35),
    '--brand-800': mix(vivid, '#FFFFFF', 0.6), '--brand-900': mix(vivid, '#FFFFFF', 0.8),
    '--button-primary': button, '--button-primary-hover': mix(button, '#000000', 0.18),
  }
  for (const k of Object.keys(dark)) dark[k] = dark[k].toUpperCase()
  return { light, dark }
}

const decls = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}:${v}`).join(';')

/** CSS text overriding the brand tokens, or '' for the default look. Only ever built from a validated hex colour. */
export function accentCss(accent: string | null | undefined): string {
  if (!accent || !isHexColor(accent)) return ''
  const { light, dark } = accentTokens(accent)
  return `:root{${decls(light)}}.dark{${decls(dark)}}`
}

/** Title for a page: "Page · Site", or just the site name. */
export function pageTitle(siteName: string, page?: string): string {
  return page ? `${page} · ${siteName}` : siteName
}

export interface FooterInput {
  siteName: string
  version: string
  build: string
  license?: { state: string; plan: string; expiresAt?: string | null } | null
  hideCredit: boolean
}

export function editionLabel(license: FooterInput['license']): string {
  if (!license) return ''
  const edition = license.plan === 'community' || license.state === 'none' ? 'Community' : license.plan === 'team' ? 'Team' : 'Enterprise'
  if (license.state === 'grace') return `${edition} (licence expired, grace period)`
  if (license.state === 'expired') return `${edition} licence expired, community features only`
  if (license.state === 'invalid') return 'Community (licence key invalid)'
  return edition
}

/** "Veqsio 1.0.0 · build abc123 · Enterprise": the text part of the footer. */
export function footerText(i: FooterInput): string {
  const parts = [`${i.siteName} ${i.version}`, `build ${i.build || 'dev'}`]
  const ed = editionLabel(i.license)
  if (ed) parts.push(ed)
  return parts.join(' · ')
}

export const CREDIT_TEXT = 'Powered by VEQSIO'

/** Whether the credit shows: only an effective (licensed) hideCredit removes it. */
export function showCredit(hideCredit: boolean): boolean {
  return !hideCredit
}

/** Version and build come from the root package.json and VEQSIO_BUILD at build time (see next.config.ts). */
export const APP_VERSION = process.env.NEXT_PUBLIC_VEQSIO_VERSION || '0.0.0'
export const APP_BUILD = process.env.NEXT_PUBLIC_VEQSIO_BUILD || 'dev'
