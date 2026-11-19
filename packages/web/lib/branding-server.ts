import { DEFAULT_BRANDING, type Branding } from './branding'

/** Server-side read of the public branding (layout metadata, accent colour without a flash). Falls back to the defaults. */
export async function fetchBranding(): Promise<Branding> {
  const base = process.env.API_INTERNAL_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3040'
  try {
    const res = await fetch(`${base}/rest/api/2/branding`, { cache: 'no-store', signal: AbortSignal.timeout(2000) })
    if (!res.ok) return DEFAULT_BRANDING
    return { ...DEFAULT_BRANDING, ...(await res.json()) } as Branding
  } catch {
    return DEFAULT_BRANDING
  }
}
