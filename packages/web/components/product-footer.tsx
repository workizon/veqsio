'use client'


import { useI18n } from '@/hooks/use-i18n'
import Link from 'next/link'
import { useBranding } from '@/hooks/use-branding'
import { useLicenseStatus } from '@/hooks/use-license'
import { APP_BUILD, APP_VERSION, DEFAULT_API_DOCS_URL, DEFAULT_DOCS_URL, footerText, showCredit } from '@/lib/branding'
import { PoweredBy } from '@/components/powered-by'

/** Where the default Documentation / API / Support links point when the administrator has not configured their own. */
export function footerLinks(b: { docsUrl: string | null; supportUrl: string | null; sourceUrl: string }) {
  const src = b.sourceUrl.replace(/\/+$/, '')
  return {
    docs: b.docsUrl || DEFAULT_DOCS_URL,
    api: DEFAULT_API_DOCS_URL,
    support: b.supportUrl || `${src}/issues`,
  }
}

/**
 * Slim product footer (name, version, build, licence edition and state, links). The link to the licence notices and the
 * source code is always present, also when the "Powered by" credit is hidden (AGPL section 13).
 * `signedIn` is false on the sign-in page, where the licence state is not available.
 */
export function ProductFooter({ signedIn = true, className = '' }: { signedIn?: boolean; className?: string }) {
  const { tr } = useI18n();

  const b = useBranding()
  const license = useLicenseStatus(signedIn)
  const links = footerLinks(b)
  const text = footerText({ siteName: b.siteName, version: APP_VERSION, build: APP_BUILD, license: signedIn ? license.data : null, hideCredit: b.hideCredit })
  const link = 'hover:text-[var(--text-primary)] hover:underline underline-offset-2'
  const ext = { target: '_blank', rel: 'noopener noreferrer' } as const
  return (
    <footer role="contentinfo" aria-label={tr('Product information')} className={`border-t border-[var(--surface-3)] px-4 lg:px-6 py-3 text-caption text-[var(--text-tertiary)] flex flex-wrap items-center gap-x-4 gap-y-1 ${className}`}>
      <span data-testid="footer-version">{text}</span>
      <nav aria-label={tr('Footer')} className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <a href={links.docs} className={link} {...ext}>{tr('Documentation')}</a>
        <a href={links.api} className={link} {...ext}>{tr('API docs')}</a>
        <a href={links.support} className={link} {...ext}>{tr('Support')}</a>
        <Link href="/about" className={link}>{tr('Licence notices')}</Link>
        <a href={b.sourceUrl} className={link} {...ext}>{tr('Source code')}</a>
      </nav>
      {showCredit(b.hideCredit) && <PoweredBy className="sm:ml-auto" />}
    </footer>
  )
}
