/** Veqsio mark: the two-tone "V". Sized by height; used where only the symbol fits (favicon-sized spots, avatars, badges). */
export function Logo({ size = 28, className = '' }: { size?: number; className?: string }) {
  return <img src="/brand/mark.png" role="img" aria-label="Veqsio" style={{ height: size, width: 'auto' }} className={`shrink-0 ${className}`} draggable={false} />
}

/** Kept for callers that want the bare mark on a coloured background. */
export function LogoMark({ size = 28, className = '' }: { size?: number; className?: string }) {
  return <Logo size={size} className={className} />
}

/** The full Veqsio logo: the "V" with the VEQSIO wordmark. Light and dark artwork switch with the theme. */
export function Wordmark({ height = 24, className = '', onDark = false }: { height?: number; className?: string; onDark?: boolean }) {
  // onDark: always the white artwork (a panel that stays dark in the light theme, such as the sign-in side panel)
  if (onDark) return <img src="/brand/wordmark-dark.png" role="img" aria-label="Veqsio" style={{ height, width: 'auto' }} className={`shrink-0 ${className}`} draggable={false} />
  return (
    <>
      <img src="/brand/wordmark-light.png" role="img" aria-label="Veqsio" style={{ height, width: 'auto' }} className={`shrink-0 dark:hidden ${className}`} draggable={false} />
      <img src="/brand/wordmark-dark.png" alt="" aria-hidden style={{ height, width: 'auto' }} className={`shrink-0 hidden dark:block ${className}`} draggable={false} />
    </>
  )
}
