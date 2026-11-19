'use client'

import Link from 'next/link'
import { BrandLockup } from '@/components/brand-logo'
import { ProductFooter } from '@/components/product-footer'
import { useBranding } from '@/hooks/use-branding'
import { useLicenseStatus } from '@/hooks/use-license'
import { APP_BUILD, APP_VERSION, editionLabel } from '@/lib/branding'

/** Public on purpose: it is the place where network users find the licence notices and the source (AGPL section 13). */
export default function AboutPage() {
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
          <Link href="/" className="ml-auto text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Back to the app</Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 space-y-6 px-4 py-8">
        <h1 className="text-heading-1">About {b.siteName}</h1>

        <section className="veqsio-card p-5 space-y-2" aria-labelledby="about-product">
          <h2 id="about-product" className="text-heading-3">Product</h2>
          <dl className="grid grid-cols-[10rem_1fr] gap-x-6 gap-y-1 text-sm">
            <dt className="text-[var(--text-tertiary)]">Name</dt><dd>{b.siteName}{b.siteName !== 'Veqsio' ? ' (based on Veqsio)' : ''}</dd>
            <dt className="text-[var(--text-tertiary)]">Version</dt><dd data-testid="about-version">{APP_VERSION}</dd>
            <dt className="text-[var(--text-tertiary)]">Build</dt><dd>{APP_BUILD}</dd>
            <dt className="text-[var(--text-tertiary)]">Licence</dt>
            <dd>{license.data ? editionLabel(license.data) : 'Sign in to see the licence state of this instance'}</dd>
          </dl>
        </section>

        <section className="veqsio-card p-5 space-y-3 text-sm" aria-labelledby="about-licences">
          <h2 id="about-licences" className="text-heading-3">Licences and source code</h2>
          <p>
            Veqsio is free software licensed under the GNU Affero General Public License, version 3 only (AGPL-3.0-only).
            Parts of the repository under the <code>ee/</code> directory are licensed under the Veqsio Enterprise License
            and need a licence key to use. The names and logos of Veqsio are trademarks of the project and are not covered by the AGPL.
          </p>
          <p>
            Third-party components are used under their own open-source licences; the package manifests in the repository list them.
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li><a className={a} href={b.sourceUrl} {...ext}>Source code of this software</a>: you are entitled to the corresponding source of the version you are using.</li>
            <li><a className={a} href={`${src}/blob/main/LICENSE`} {...ext}>LICENSE</a> (AGPL-3.0)</li>
            <li><a className={a} href={`${src}/blob/main/NOTICE`} {...ext}>NOTICE</a> (copyright and trademark notice)</li>
            <li><a className={a} href={`${src}/blob/main/TRADEMARK.md`} {...ext}>Trademark policy</a></li>
          </ul>
        </section>
      </main>
      <ProductFooter signedIn={false} />
    </div>
  )
}
