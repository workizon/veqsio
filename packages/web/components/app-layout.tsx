import { Sidebar } from '@/components/sidebar'
import { Header } from '@/components/header'
import { Suspense, useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { AdminSidebar } from '@/components/admin/admin-sidebar'
import { AnnouncementBanner } from '@/components/announcement-banner'
import { LicenceBanner } from '@/components/licence-banner'
import { ProjectSidebar } from '@/components/project/project-sidebar'
import { resolveProjectContext } from '@/lib/project-nav'
import { ProductFooter } from '@/components/product-footer'

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const pathname = usePathname() || ''
  const isAdmin = pathname === '/admin' || pathname.startsWith('/admin/')
  // The project menu also stays on Issues / Board / Backlog / Roadmap / Reports for the project you came from.
  const [remembered, setRemembered] = useState<string | null>(null)
  const ctx = isAdmin ? { key: null, remember: null } : resolveProjectContext(pathname, remembered)
  const projectKey = ctx.key
  useEffect(() => {
    try {
      if (remembered === null && ctx.remember === null) {
        const saved = window.sessionStorage.getItem('veqsio-project-context')
        if (saved) setRemembered(saved)
        return
      }
      if (ctx.remember !== remembered) setRemembered(ctx.remember)
      if (ctx.remember) window.sessionStorage.setItem('veqsio-project-context', ctx.remember)
      else window.sessionStorage.removeItem('veqsio-project-context')
    } catch { /* storage unavailable */ }
  }, [ctx.remember, remembered])
  const sided = isAdmin || !!projectKey

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 1280px)')
    const closeOnDesktop = () => { if (desktop.matches) setMobileMenuOpen(false) }
    desktop.addEventListener('change', closeOnDesktop)
    return () => desktop.removeEventListener('change', closeOnDesktop)
  }, [])

  return (
    <div className="min-h-screen bg-[var(--surface-1)]">
      <Sidebar mobileOpen={mobileMenuOpen} onMobileClose={() => setMobileMenuOpen(false)} />
      <Header onMenuToggle={() => setMobileMenuOpen(!mobileMenuOpen)} />
      <main className="pt-header min-h-screen flex flex-col">
        <AnnouncementBanner />
        <LicenceBanner />
        <div className={`p-4 lg:p-6 w-full flex-1 ${sided ? 'lg:flex lg:gap-8' : ''}`}>
          {isAdmin && <Suspense fallback={null}><AdminSidebar /></Suspense>}
          {projectKey && <Suspense fallback={null}><ProjectSidebar projectKey={projectKey} /></Suspense>}
          <div className={sided ? 'min-w-0 flex-1' : 'contents'}>{children}</div>
        </div>
        <ProductFooter />
      </main>
    </div>
  )
}
