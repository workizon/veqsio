import Link from 'next/link'
import { Logo } from '@/components/logo'

/** Minimal chrome for the anonymous pages: no app navigation, a way in for members. Server component. */
export function PublicShell({ siteName, children }: { siteName: string; children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-[var(--surface-1)] text-[var(--text-primary)]">
      <header className="border-b border-[var(--surface-3)] bg-[var(--surface-0)]">
        <div className="mx-auto flex max-w-5xl items-center gap-4 px-4 py-3">
          <Link href="/p" className="flex items-center gap-2 font-semibold"><Logo size={24} />{siteName}</Link>
          <nav aria-label="Public" className="flex-1 text-body-sm"><Link href="/p" className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Projects</Link></nav>
          <Link href="/login" className="veqsio-btn-secondary text-sm">Sign in</Link>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
      <footer className="mx-auto max-w-5xl px-4 pb-10 text-caption text-[var(--text-tertiary)]">Read-only public view. Powered by Veqsio.</footer>
    </div>
  )
}
