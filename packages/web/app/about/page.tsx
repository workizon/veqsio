'use client'


import { useI18n } from '@/hooks/use-i18n'
import Link from 'next/link'
import { BrandLockup } from '@/components/brand-logo'
import { ProductFooter } from '@/components/product-footer'
import { useBranding } from '@/hooks/use-branding'
import { useLicenseStatus } from '@/hooks/use-license'
import { APP_BUILD, APP_VERSION, editionLabel } from '@/lib/branding'

/** Public on purpose: it is the place where network users find the licence notices and the source (AGPL section 13). */
export default function AboutPage() {
  const { tr } = useI18n();

  const b = useBranding()
  const license = useLicenseStatus()
  const src = b.sourceUrl.replace(/\/+$/, '')
  const ext = { target: '_blank', rel: 'noopener noreferrer' } as const
  const a = 'text-[var(--brand-600)] hover:underline'
  return (
    <div className="min-h-dvh flex flex-col bg-[var(--surface-1)] text-[var(--text-primary)]">
      <header className="border-b border-[var(--surface-3)] bg-[var(--surface-0)]">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          <Link href="/" className="flex items-center" aria-label={b.siteName}><BrandLockup height={24} /></Link>
          <Link href="/" className="ml-auto text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">{tr('Back to the app')}</Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 space-y-6 px-4 py-8">
        <h1 className="text-heading-1">{tr('About')} {b.siteName}</h1>

        <section className="veqsio-card p-5 space-y-2" aria-labelledby="about-product">
          <h2 id="about-product" className="text-heading-3">{tr('Product')}</h2>
          <dl className="grid grid-cols-[10rem_1fr] gap-x-6 gap-y-1 text-sm">
            <dt className="text-[var(--text-tertiary)]">{tr('Name')}</dt><dd>{b.siteName}{b.siteName !== 'Veqsio' ? tr(' (based on Veqsio)') : ''}</dd>
            <dt className="text-[var(--text-tertiary)]">{tr('Version')}</dt><dd data-testid="about-version">{APP_VERSION}</dd>
            <dt className="text-[var(--text-tertiary)]">{tr('Build')}</dt><dd>{APP_BUILD}</dd>
            <dt className="text-[var(--text-tertiary)]">{tr('Licence')}</dt>
            <dd>{license.data ? editionLabel(license.data) : tr('Sign in to see the licence state of this instance')}</dd>
          </dl>
        </section>

        <section className="veqsio-card p-5 space-y-3 text-sm" aria-labelledby="about-licences">
          <h2 id="about-licences" className="text-heading-3">{tr('Licences and source code')}</h2>
          <p>
            {tr('Veqsio is free software licensed under the GNU Affero General Public License, version 3 only (AGPL-3.0-only). Parts of the repository under the')} <code>ee/</code> {tr('directory are licensed under the Veqsio Enterprise License and need a licence key to use. The names and logos of Veqsio are trademarks of the project and are not covered by the AGPL.')} </p>
          <p>
            {tr('Third-party components are used under their own open-source licences; the package manifests in the repository list them.')} </p>
          <ul className="list-disc pl-5 space-y-1">
            <li><a className={a} href={b.sourceUrl} {...ext}>{tr('Source code of this software')}</a>{tr(': you are entitled to the corresponding source of the version you are using.')}</li>
            <li><a className={a} href={`${src}/blob/main/LICENSE`} {...ext}>{tr('LICENSE')}</a> {tr('(AGPL-3.0)')}</li>
            <li><a className={a} href={`${src}/blob/main/NOTICE`} {...ext}>{tr('NOTICE')}</a> {tr('(copyright and trademark notice)')}</li>
            <li><a className={a} href={`${src}/blob/main/TRADEMARK.md`} {...ext}>{tr('Trademark policy')}</a></li>
          </ul>
        </section>
      </main>
      <ProductFooter signedIn={false} />
    </div>
  )
}
