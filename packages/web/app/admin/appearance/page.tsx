'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useRef, useState } from 'react'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { FeatureGate } from '@/components/feature-gate'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import {
  useAdminBranding, useRemoveBrandingFile, useResetBranding, useSaveBranding, useUploadBrandingFile, type AdminBranding,
} from '@/hooks/use-branding'
import { MAX_LOGO_BYTES, checkAccent, contrastRatio, isHexColor } from '@/lib/branding'
import { confirmDialog } from '@/components/dialogs'

type Slot = 'light' | 'dark' | 'favicon'

const SLOTS: Array<{ slot: Slot; title: string; hint: string; accept: string; panel: string }> = [
  { slot: 'light', title: 'Logo (light theme)', hint: 'PNG or SVG, up to 512 KB. Shown on light backgrounds.', accept: 'image/png,image/svg+xml,.svg,.png', panel: 'bg-white' },
  { slot: 'dark', title: 'Logo (dark theme)', hint: 'Optional. Shown on dark backgrounds; the light logo is used when this is empty.', accept: 'image/png,image/svg+xml,.svg,.png', panel: 'bg-[#1B1C1E]' },
  { slot: 'favicon', title: 'Favicon', hint: 'PNG, SVG or ICO, up to 512 KB. Shown in the browser tab.', accept: 'image/png,image/svg+xml,image/x-icon,.svg,.png,.ico', panel: 'bg-[var(--surface-2)]' },
]

function FileCard({ slot, title, hint, accept, panel, url }: (typeof SLOTS)[number] & { url: string | null }) {
  const { tr } = useI18n();

  const input = useRef<HTMLInputElement>(null)
  const upload = useUploadBrandingFile()
  const remove = useRemoveBrandingFile()
  const pick = (file: File | undefined) => {
    if (!file) return
    if (file.size > MAX_LOGO_BYTES) { toast(tr('The file is too large (maximum 512 KB)'), 'error'); return }
    upload.mutate({ slot, file }, { onSuccess: () => toast(tr('Image saved'), 'success'), onError: (e) => toast((e as Error).message, 'error') })
    if (input.current) input.current.value = ''
  }
  return (
    <div className="veqsio-card p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold">{tr(title)}</h3>
        <p className="text-xs text-[var(--text-tertiary)]">{tr(hint)}</p>
      </div>
      <div className={`h-20 rounded border border-[var(--surface-3)] flex items-center justify-center ${panel}`}>
        {/* Uploaded files are only ever rendered through <img>, never inlined. */}
        {url ? <img src={url} alt={tr('{title} preview', { title: tr(title) })} className="max-h-14 max-w-[80%] object-contain" /> : <span className="text-xs text-[var(--text-tertiary)]">{tr('Default (Veqsio)')}</span>}
      </div>
      <div className="flex gap-2">
        <input ref={input} type="file" accept={accept} className="sr-only" aria-label={tr('Upload {title}', { title: tr(title) })} onChange={(e) => pick(e.target.files?.[0])} />
        <button type="button" className="veqsio-btn-secondary text-sm" disabled={upload.isPending} onClick={() => input.current?.click()}>{url ? tr('Replace') : tr('Upload')}</button>
        {url && <button type="button" className="veqsio-btn-ghost text-sm" disabled={remove.isPending} onClick={() => remove.mutate(slot, { onError: (e) => toast((e as Error).message, 'error') })}>{tr('Remove')}</button>}
      </div>
    </div>
  )
}

function Settings({ data }: { data: AdminBranding }) {
  const { tr } = useI18n();

  const save = useSaveBranding()
  const reset = useResetBranding()
  const [siteName, setSiteName] = useState(data.stored.siteName ?? '')
  const [accent, setAccent] = useState(data.stored.accentColor ?? '')
  const [supportUrl, setSupportUrl] = useState(data.stored.supportUrl ?? '')
  const [docsUrl, setDocsUrl] = useState(data.stored.docsUrl ?? '')
  useEffect(() => {
    setSiteName(data.stored.siteName ?? ''); setAccent(data.stored.accentColor ?? '')
    setSupportUrl(data.stored.supportUrl ?? ''); setDocsUrl(data.stored.docsUrl ?? '')
  }, [data.stored])

  const accentError = accent ? checkAccent(accent) : null
  const ratio = isHexColor(accent) ? contrastRatio(accent, '#FFFFFF') : null
  const dirty = siteName !== (data.stored.siteName ?? '') || accent !== (data.stored.accentColor ?? '') || supportUrl !== (data.stored.supportUrl ?? '') || docsUrl !== (data.stored.docsUrl ?? '')

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    save.mutate(
      { siteName: siteName.trim() || null, accentColor: accent || null, supportUrl: supportUrl.trim() || null, docsUrl: docsUrl.trim() || null },
      { onSuccess: () => toast(tr('Appearance saved'), 'success'), onError: (e) => toast((e as Error).message, 'error') },
    )
  }

  return (
    <div className="space-y-6">
      <form onSubmit={submit} className="veqsio-card p-5 space-y-4">
        <h2 className="text-heading-3">{tr('Name and colour')}</h2>
        <label className="block text-sm space-y-1">{tr('Site name')} <input className="veqsio-input block w-full max-w-md" value={siteName} maxLength={60} placeholder={tr('Veqsio')} onChange={(e) => setSiteName(e.target.value)} />
          <span className="block text-xs text-[var(--text-tertiary)]">{tr('Shown in the header, on the sign-in page, in page titles and in the footer.')}</span>
        </label>
        <div className="space-y-1 text-sm">
          <label htmlFor="accent-hex">{tr('Accent colour')}</label>
          <div className="flex items-center gap-3">
            <input type="color" aria-label={tr('Pick the accent colour')} className="h-9 w-12 rounded border border-[var(--surface-3)] bg-transparent p-0.5" value={isHexColor(accent) ? accent : '#3D6AF0'} onChange={(e) => setAccent(e.target.value.toUpperCase())} />
            <input id="accent-hex" className="veqsio-input w-32 font-mono" value={accent} placeholder="#3D6AF0" maxLength={7} onChange={(e) => setAccent(e.target.value.trim())} aria-invalid={!!accentError} aria-describedby="accent-help" />
            {accent && <button type="button" className="veqsio-btn-ghost text-sm" onClick={() => setAccent('')}>{tr('Use default')}</button>}
            {isHexColor(accent) && !accentError && <span className="inline-block h-9 px-3 rounded text-white text-sm leading-9" style={{ background: accent }}>{tr('Preview')}</span>}
          </div>
          <p id="accent-help" role={accentError ? 'alert' : undefined} className={`text-xs ${accentError ? 'text-[var(--error)]' : 'text-[var(--text-tertiary)]'}`}>
            {accentError ?? (ratio ? tr('Contrast on white: {ratio}:1 (at least {min}:1 is required).', { ratio: ratio.toFixed(1), min: data.limits.minAccentContrast }) : tr('Optional. Replaces the blue accent. Contrast on white must be at least {min}:1.', { min: data.limits.minAccentContrast }))}
          </p>
        </div>
        <h2 className="text-heading-3 pt-2">{tr('Footer links')}</h2>
        <div className="grid gap-4 sm:grid-cols-2 max-w-3xl">
          <label className="block text-sm space-y-1">{tr('Support URL')} <input className="veqsio-input block w-full" inputMode="url" value={supportUrl} placeholder="https://help.example.com" onChange={(e) => setSupportUrl(e.target.value)} />
          </label>
          <label className="block text-sm space-y-1">{tr('Documentation URL')} <input className="veqsio-input block w-full" inputMode="url" value={docsUrl} placeholder="https://docs.example.com" onChange={(e) => setDocsUrl(e.target.value)} />
          </label>
        </div>
        <div className="flex gap-2">
          <button className="veqsio-btn-primary" disabled={!dirty || !!accentError || save.isPending}>{tr('Save')}</button>
        </div>
      </form>

      <section aria-labelledby="images-h" className="space-y-3">
        <h2 id="images-h" className="text-heading-3">{tr('Logo and favicon')}</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {SLOTS.map((s) => <FileCard key={s.slot} {...s} url={s.slot === 'light' ? data.logoLightUrl : s.slot === 'dark' ? data.logoDarkUrl : data.faviconUrl} />)}
        </div>
        <p className="text-xs text-[var(--text-tertiary)]">{tr('SVG files with scripts, event handlers or external references are refused. Images are shown through an image tag only.')}</p>
      </section>

      <section aria-labelledby="credit-h" className="space-y-3">
        <h2 id="credit-h" className="text-heading-3">{tr('Product credit')}</h2>
        <FeatureGate feature="branding" label={tr('Hiding the Powered by VEQSIO credit')}>
          <div className="veqsio-card p-5 space-y-2">
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={data.stored.hideCredit} disabled={save.isPending} onChange={(e) => save.mutate({ hideCredit: e.target.checked }, { onError: (err) => toast((err as Error).message, 'error') })} className="mt-0.5" />
              <span>{tr('Hide "Powered by VEQSIO" in the footer')}</span>
            </label>
            <p className="text-xs text-[var(--text-tertiary)]">{tr('The link to the licence notices and the source code stays in the footer and on the About page.')}</p>
          </div>
        </FeatureGate>
        <p className="text-xs text-[var(--text-tertiary)]">{tr('Changing the logo, name and colours is free. Only removing the credit needs the Enterprise licence.')}</p>
      </section>

      <div>
        <button type="button" className="veqsio-btn-secondary" disabled={reset.isPending}
          onClick={async () => (await confirmDialog(tr('Reset the name, colour, logos, favicon and footer links to the Veqsio defaults?'))) && reset.mutate(undefined, { onSuccess: () => toast(tr('Appearance reset to the defaults'), 'success'), onError: (e) => toast((e as Error).message, 'error') })}>
          {tr('Reset to default')} </button>
      </div>
    </div>
  )
}

export default function AppearancePage() {
  const { tr } = useI18n();

  const q = useAdminBranding()
  return (
    <AppLayout>
      <div className="space-y-4">
        <PageHeader title={tr('Appearance')} description={tr('Make this installation look like yours: name, logo, favicon and accent colour.')} />
        {q.isLoading && <Spinner />}
        {q.error && <p role="alert" className="text-[var(--error)]">{(q.error as Error).message}</p>}
        {q.data && <Settings data={q.data} />}
      </div>
    </AppLayout>
  )
}
