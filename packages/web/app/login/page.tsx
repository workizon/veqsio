'use client'

import { LoginForm } from '@/components/login-form'
import { BrandLockup } from '@/components/brand-logo'
import { ProductFooter } from '@/components/product-footer'
import { usePublicSettings } from '@/hooks/use-instance-settings'
import { AnnouncementBanner } from '@/components/announcement-banner'
import { ThemeToggle } from '@/components/theme-toggle'
import { ArrowUpRight, Layers3, CheckCircle2, GitBranch } from 'lucide-react'

export default function LoginPage() {
  const { data: pub } = usePublicSettings()
  return (
    <div className="min-h-dvh grid lg:grid-cols-2 bg-[var(--surface-0)] relative">
      <div className="absolute inset-x-0 top-0 z-10 lg:col-span-2"><AnnouncementBanner /></div>
      <aside className="hidden lg:flex flex-col justify-between bg-[#111827] text-white p-8 xl:p-12 relative overflow-hidden">
        <div className="self-start"><BrandLockup height={30} onDark /></div>
        <div className="py-8 max-w-lg relative">
          <p className="text-xs font-medium tracking-[0.18em] uppercase text-[#A5B4FC] mb-6">A clearer way to work</p>
          <h2 className="text-4xl xl:text-5xl [@media(min-height:900px)]:text-6xl font-semibold tracking-[-0.045em] leading-[1.08]">Big ideas.<br />Clear next steps.</h2>
          <p className="mt-4 text-base leading-7 text-slate-300 max-w-sm">Bring your projects, issues and team into one focused workspace.</p>
          <div className="mt-8 border-t border-white/15 divide-y divide-white/10">
            {[
              { icon: Layers3, title: 'Keep the work in view', detail: 'Issues, boards and backlogs' },
              { icon: GitBranch, title: 'Find your flow', detail: 'Workflows that fit your team' },
              { icon: CheckCircle2, title: 'Move forward together', detail: 'From the first idea to done' },
            ].map(({ icon: Icon, title, detail }) => (
              <div key={title} className="flex items-center gap-4 py-3 [@media(min-height:900px)]:py-5">
                <Icon className="w-5 h-5 text-[#A5B4FC]" aria-hidden="true" />
                <div className="flex-1"><p className="text-sm font-medium">{title}</p><p className="text-xs text-slate-400 mt-1">{detail}</p></div>
                <ArrowUpRight className="w-4 h-4 text-slate-500" aria-hidden="true" />
              </div>
            ))}
          </div>
        </div>
        <p className="text-xs text-slate-400">Built for teams that build.</p>
      </aside>
      <main className="relative flex flex-col min-w-0">
        <div className="absolute right-6 top-6"><ThemeToggle /></div>
        <div className="flex-1 flex items-center justify-center px-6 py-12 sm:px-12">
          <div className="w-full max-w-sm"><LoginForm />{pub?.publicProjects && <p className="mt-6 text-center text-sm"><a href="/p" className="text-[var(--brand-600)] hover:underline">Browse public projects</a></p>}</div>
        </div>
        <ProductFooter signedIn={false} />
      </main>
    </div>
  )
}
