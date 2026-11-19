'use client'

import { PoweredBy } from '@/components/powered-by'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, LogOut, Moon, Sun } from 'lucide-react'
import { usePortal } from '@/hooks/use-servicedesk'
import { useMyself } from '@/hooks/use-issues'
import { Avatar } from '@/components/avatar'
import { Logo } from '@/components/logo'
import { useTheme } from '@/components/theme-provider'
import { signOut } from '@/lib/session'

/** Width of the content column: `wide` for lists and the home page, `narrow` for forms and reading. */
const WIDTHS = { wide: 'max-w-5xl', narrow: 'max-w-3xl' } as const

function NavLinks({ slug, className }: { slug: string; className: string }) {
  const pathname = usePathname() ?? ''
  const mine = pathname.startsWith(`/portal/${slug}/requests`)
  const items = [
    { href: `/portal/${slug}`, label: 'Raise a request', active: !mine },
    { href: `/portal/${slug}/requests`, label: 'My requests', active: mine },
  ]
  return (
    <nav aria-label="Portal" className={className}>
      {items.map((i) => (
        <Link
          key={i.href} href={i.href} aria-current={i.active ? 'page' : undefined}
          className={`relative inline-flex items-center h-11 px-3 text-body font-medium rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-300)] ${
            i.active ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
          }`}
        >
          {i.label}
          {i.active && <span aria-hidden className="absolute left-3 right-3 -bottom-px h-0.5 rounded-full bg-[var(--brand-500)]" />}
        </Link>
      ))}
    </nav>
  )
}

function UserMenu() {
  const router = useRouter()
  const { theme, toggleTheme } = useTheme()
  const me = useMyself()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  if (me.isLoading) return <div aria-hidden className="h-9 w-16 rounded-full bg-[var(--surface-2)] animate-pulse" />
  if (!me.data) return <Link href="/login" className="veqsio-btn-secondary text-sm min-h-[44px] inline-flex items-center">Sign in</Link>

  const name = me.data.displayName || me.data.name || 'Account'
  return (
    <div className="relative" ref={ref}>
      <button
        type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 h-11 pl-1.5 pr-2 rounded-full hover:bg-[var(--surface-2)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-300)]"
      >
        <span className="sr-only">Account menu for {name}</span>
        <Avatar name={name} size="lg" className="!w-8 !h-8" />
        <ChevronDown aria-hidden className={`w-4 h-4 text-[var(--text-tertiary)] transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div role="menu" aria-label="Account" className="absolute right-0 mt-2 w-64 rounded-xl border border-[var(--surface-3)] bg-[var(--surface-0)] shadow-[var(--shadow-lg)] p-1.5 z-30">
          <div className="px-3 py-2.5 border-b border-[var(--surface-3)] mb-1.5">
            <div className="text-body font-medium text-[var(--text-primary)] truncate">{name}</div>
            {me.data.emailAddress && <div className="text-caption text-[var(--text-tertiary)] truncate">{me.data.emailAddress}</div>}
          </div>
          <button role="menuitem" type="button" onClick={toggleTheme} className="w-full flex items-center gap-2.5 px-3 min-h-[44px] rounded-lg text-body text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] text-left">
            {theme === 'light' ? <Moon aria-hidden className="w-4 h-4" /> : <Sun aria-hidden className="w-4 h-4" />}
            {theme === 'light' ? 'Dark theme' : 'Light theme'}
          </button>
          <button role="menuitem" type="button" onClick={() => signOut(router)} className="w-full flex items-center gap-2.5 px-3 min-h-[44px] rounded-lg text-body text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] text-left">
            <LogOut aria-hidden className="w-4 h-4" />
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Portal chrome. Title, logo and accent colour come from the desk's portal settings (cached query,
 * shared with the portal pages); the accent only overrides the brand variable inside the portal.
 * `hero` renders full-bleed under the header (portal home); `width` sizes the content column.
 */
export function PortalShell({ slug, title, children, hero, width = 'wide' }: {
  slug: string; title?: string; children: React.ReactNode; hero?: React.ReactNode; width?: keyof typeof WIDTHS
}) {
  const portal = usePortal(slug).data
  const heading = portal?.portalTitle || title || portal?.name || 'Help center'
  const accent = portal?.accentColor && /^#[0-9a-fA-F]{6}$/.test(portal.accentColor) ? portal.accentColor : undefined
  const style = accent ? ({ '--brand-500': accent, '--brand-600': accent } as React.CSSProperties) : undefined
  const logo = portal?.logoUrl && /^(https:\/\/|\/(?!\/))/.test(portal.logoUrl) ? portal.logoUrl : null
  return (
    <div className="min-h-dvh flex flex-col bg-[var(--surface-1)] text-[var(--text-primary)]" style={style}>
      <header className="sticky top-0 z-20 bg-[color-mix(in_srgb,var(--surface-0)_88%,transparent)] backdrop-blur border-b border-[var(--surface-3)]">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center gap-4">
          <Link href={`/portal/${slug}`} className="flex items-center gap-2.5 min-w-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-300)]">
            {logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logo} alt="" className="h-8 w-auto max-w-[120px] object-contain" />
            ) : (
              <Logo size={32} />
            )}
            <span className="text-heading-2 text-[var(--text-primary)] truncate">{heading}</span>
          </Link>
          <NavLinks slug={slug} className="hidden sm:flex items-center gap-1 ml-4 self-stretch" />
          <div className="ml-auto"><UserMenu /></div>
        </div>
        <NavLinks slug={slug} className="sm:hidden flex items-center gap-1 px-3 border-t border-[var(--surface-3)]" />
      </header>

      {hero}

      <main className={`${WIDTHS[width]} w-full mx-auto px-4 sm:px-6 py-8 sm:py-10 space-y-8 flex-1`}>{children}</main>

      <footer className="border-t border-[var(--surface-3)] bg-[var(--surface-0)]">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 flex flex-wrap items-center justify-between gap-3 text-caption text-[var(--text-tertiary)]">
          <span>{heading}</span>
          <span className="inline-flex items-center gap-2"><Logo size={16} /><PoweredBy /></span>
        </div>
      </footer>
    </div>
  )
}

/** Shared page title block for inner portal pages. */
export function PortalHeading({ title, description, action, back }: { title: string; description?: string; action?: React.ReactNode; back?: React.ReactNode }) {
  return (
    <div className="space-y-2">
      {back}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-display text-[var(--text-primary)]">{title}</h1>
          {description && <p className="mt-1 text-body text-[var(--text-secondary)]">{description}</p>}
        </div>
        {action}
      </div>
    </div>
  )
}

/** Locale-aware relative time ("3 hours ago"); falls back to the date for anything older than a month. */
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diff = (then - Date.now()) / 1000
  const abs = Math.abs(diff)
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (abs < 60) return rtf.format(0, 'second')
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour')
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day')
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}
