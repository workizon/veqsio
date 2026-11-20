'use client'


import { useI18n } from '@/hooks/use-i18n'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import * as Dialog from '@radix-ui/react-dialog'
import { Plus, X } from 'lucide-react'
import { BrandLogo, BrandName } from './brand-logo'
import { ThemeToggle } from './theme-toggle'
import { NAV_GROUPS, ADMIN_LINKS } from '@/lib/routes'
import { useTerm } from '@/hooks/use-term'

export function Sidebar({ mobileOpen = false, onMobileClose }: { mobileOpen?: boolean; onMobileClose?: () => void }) {
  const { tr } = useI18n();

  const pathname = usePathname()
  const { t } = useTerm()
  return (
    <Dialog.Root open={mobileOpen} onOpenChange={(open) => { if (!open) onMobileClose?.() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/45 backdrop-blur-sm z-40 min-[1440px]:hidden" />
        <Dialog.Content aria-describedby={undefined} className="fixed inset-y-0 left-0 z-50 w-[min(320px,calc(100vw-32px))] bg-[var(--surface-0)] border-r border-[var(--surface-3)] shadow-xl flex flex-col xl:hidden">
          <div className="flex items-center justify-between p-5 border-b border-[var(--surface-3)]">
            <Dialog.Title className="flex items-center gap-3 font-semibold"><BrandLogo size={28} /><BrandName /></Dialog.Title>
            <Dialog.Close className="veqsio-btn-ghost p-2" aria-label={tr('Close navigation')}><X className="w-5 h-5" /></Dialog.Close>
          </div>
          <div className="p-4"><Link href="/issues/create" onClick={onMobileClose} className="veqsio-btn-primary w-full"><Plus className="w-4 h-4" />{t('Create issue')}</Link></div>
          <nav aria-label={tr('Mobile navigation')} className="flex-1 overflow-y-auto px-3 pb-4 space-y-5">
            {[...NAV_GROUPS.map((group) => ({ label: group.label, items: group.href ? [{ href: group.href, label: group.label }] : group.items ?? [] })), { label: tr('Administration'), items: ADMIN_LINKS }].map((group) => (
              <div key={group.label}>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-tertiary)] px-3 mb-1">{t(group.label)}</p>
                {group.items.map((item) => {
                  const active = pathname === item.href
                  return <Link key={item.href} href={item.href} onClick={onMobileClose} aria-current={active ? 'page' : undefined} className={`block rounded-lg px-3 py-2.5 text-sm transition-colors ${active ? 'bg-[var(--brand-50)] text-[var(--brand-700)] font-medium' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)]'}`}>{t(item.label)}</Link>
                })}
              </div>
            ))}
          </nav>
          <div className="border-t border-[var(--surface-3)] p-4 flex items-center justify-between"><span className="text-xs text-[var(--text-secondary)]">{tr('Appearance')}</span><ThemeToggle /></div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
