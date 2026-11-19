'use client'

import { Logo, Wordmark } from './logo'
import { useBranding } from '@/hooks/use-branding'

/**
 * The product logo: the administrator's uploaded logo (light and dark variants) or the Veqsio mark.
 * Uploaded files are rendered only through <img>, never inlined, so an SVG cannot run scripts here.
 */
export function BrandLogo({ size = 28, className = '' }: { size?: number; className?: string }) {
  const b = useBranding()
  const light = b.logoLightUrl ?? b.logoDarkUrl
  const dark = b.logoDarkUrl ?? b.logoLightUrl
  if (!light || !dark) return <Logo size={size} className={className} />
  const style = { height: size, maxWidth: size * 5 }
  const common = 'w-auto object-contain shrink-0'
  return (
    <>
      <img src={light} alt="" style={style} className={`${common} dark:hidden ${className}`} />
      <img src={dark} alt="" style={style} className={`${common} hidden dark:block ${className}`} />
    </>
  )
}

/** Logo plus the site name, as shown in the header and on the sign-in page. */
export function BrandName({ className = '' }: { className?: string }) {
  return <span className={className}>{useBranding().siteName}</span>
}

/** Header / sign-in lockup: the Veqsio wordmark by default, or the administrator's logo and site name when branding is configured. */
export function BrandLockup({ height = 24, onDark = false }: { height?: number; onDark?: boolean }) {
  const b = useBranding()
  if (b.logoLightUrl || b.logoDarkUrl || b.siteName !== 'Veqsio') {
    return <span className="flex items-center gap-2"><BrandLogo size={height + 4} /><BrandName className={`font-semibold text-[15px] tracking-tight ${onDark ? 'text-white' : 'text-[var(--text-primary)]'}`} /></span>
  }
  return <Wordmark height={height} onDark={onDark} />
}
