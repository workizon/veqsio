'use client'

import { useEffect } from 'react'
import { useBranding } from '@/hooks/use-branding'
import { accentCss } from '@/lib/branding'

/**
 * Keeps the accent colour in sync after the administrator changes it, without a reload. The server renders the same CSS
 * into <head> for the first paint; once this component mounts it takes over. The CSS is built only from a validated #rrggbb.
 */
export function AccentStyle() {
  const css = accentCss(useBranding().accentColor)
  useEffect(() => { document.getElementById('veqsio-accent')?.remove() }, [])
  return css ? <style id="veqsio-accent-live" dangerouslySetInnerHTML={{ __html: css }} /> : null
}
