import pkg from '../../../package.json'

/** Single source of truth: the version in the root package.json (the web app reads the same value at build time). */
export const VERSION: string = (pkg as { version: string }).version
export const VERSION_NUMBERS: number[] = VERSION.split('.').map((n) => parseInt(n, 10) || 0).slice(0, 3)

/** Build identifier (commit or CI run) injected at build/deploy time as VEQSIO_BUILD; "dev" when not set. */
export function buildId(): string {
  return (process.env.VEQSIO_BUILD || '').trim().slice(0, 64) || 'dev'
}

export const DEFAULT_SOURCE_URL = 'https://github.com/workizon/veqsio'

/** Where network users can obtain the corresponding source (AGPL section 13). Configurable for forks. */
export function sourceUrl(): string {
  const v = (process.env.VEQSIO_SOURCE_URL || '').trim()
  return /^https?:\/\//i.test(v) ? v : DEFAULT_SOURCE_URL
}
