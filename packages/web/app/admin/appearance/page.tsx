'use client'

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
  const input = useRef<HTMLInputElement>(null)
  const upload = useUploadBrandingFile()
  const remove = useRemoveBrandingFile()
  const pick = (file: File | undefined) => {
    if (!file) return
    if (file.size > MAX_LOGO_BYTES) { toast('The file is too large (maximum 512 KB)', 'error'); return }
    upload.mutate({ slot, file }, { onSuccess: () => toast('Image saved', 'success'), onError: (e) => toast((e as Error).message, 'error') })
    if (input.current) input.current.value = ''
  }
  return (
    <div className="veqsio-card p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-[var(--text-tertiary)]">{hint}</p>
      </div>
      <div className={`h-20 rounded border border-[var(--surface-3)] flex items-center justify-center ${panel}`}>
        {/* Uploaded files are only ever rendered through <img>, never inlined. */}
        {url ? <img src={url} alt={`${title} preview`} className="max-h-14 max-w-[80%] object-contain" /> : <span className="text-xs text-[var(--text-tertiary)]">Default (Veqsio)</span>}
      </div>
      <div className="flex gap-2">
        <input ref={input} type="file" accept={accept} className="sr-only" aria-label={`Upload ${title}`} onChange={(e) => pick(e.target.files?.[0])} />
        <button type="button" className="veqsio-btn-secondary text-sm" disabled={upload.isPending} onClick={() => input.current?.click()}>{url ? 'Replace' : 'Upload'}</button>
        {url && <button type="button" className="veqsio-btn-ghost text-sm" disabled={remove.isPending} onClick={() => remove.mutate(slot, { onError: (e) => toast((e as Error).message, 'error') })}>Remove</button>}
      </div>
    </div>
  )
}

function Settings({ data }: { data: AdminBranding }) {
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
      { onSuccess: () => toast('Appearance saved', 'success'), onError: (e) => toast((e as Error).message, 'error') },
    )
  }

  return (
    <div className="space-y-6">
      <form onSubmit={submit} className="veqsio-card p-5 space-y-4">
        <h2 className="text-heading-3">Name and colour</h2>
        <label className="block text-sm space-y-1">Site name
          <input className="veqsio-input block w-full max-w-md" value={siteName} maxLength={60} placeholder="Veqsio" onChange={(e) => setSiteName(e.target.value)} />
          <span className="block text-xs text-[var(--text-tertiary)]">Shown in the header, on the sign-in page, in page titles and in the footer.</span>
        </label>
        <div className="space-y-1 text-sm">
          <label htmlFor="accent-hex">Accent colour</label>
          <div className="flex items-center gap-3">
            <input type="color" aria-label="Pick the accent colour" className="h-9 w-12 rounded border border-[var(--surface-3)] bg-transparent p-0.5" value={isHexColor(accent) ? accent : '#3D6AF0'} onChange={(e) => setAccent(e.target.value.toUpperCase())} />
            <input id="accent-hex" className="veqsio-input w-32 font-mono" value={accent} placeholder="#3D6AF0" maxLength={7} onChange={(e) => setAccent(e.target.value.trim())} aria-invalid={!!accentError} aria-describedby="accent-help" />
            {accent && <button type="button" className="veqsio-btn-ghost text-sm" onClick={() => setAccent('')}>Use default</button>}
            {isHexColor(accent) && !accentError && <span className="inline-block h-9 px-3 rounded text-white text-sm leading-9" style={{ background: accent }}>Preview</span>}
          </div>
          <p id="accent-help" role={accentError ? 'alert' : undefined} className={`text-xs ${accentError ? 'text-[var(--error)]' : 'text-[var(--text-tertiary)]'}`}>
            {accentError ?? (ratio ? `Contrast on white: ${ratio.toFixed(1)}:1 (at least ${data.limits.minAccentContrast}:1 is required).` : `Optional. Replaces the blue accent. Contrast on white must be at least ${data.limits.minAccentContrast}:1.`)}
          </p>
        </div>
        <h2 className="text-heading-3 pt-2">Footer links</h2>
        <div className="grid gap-4 sm:grid-cols-2 max-w-3xl">
          <label className="block text-sm space-y-1">Support URL
            <input className="veqsio-input block w-full" inputMode="url" value={supportUrl} placeholder="https://help.example.com" onChange={(e) => setSupportUrl(e.target.value)} />
          </label>
          <label className="block text-sm space-y-1">Documentation URL
            <input className="veqsio-input block w-full" inputMode="url" value={docsUrl} placeholder="https://docs.example.com" onChange={(e) => setDocsUrl(e.target.value)} />
          </label>
        </div>
        <div className="flex gap-2">
          <button className="veqsio-btn-primary" disabled={!dirty || !!accentError || save.isPending}>Save</button>
        </div>
      </form>

      <section aria-labelledby="images-h" className="space-y-3">
        <h2 id="images-h" className="text-heading-3">Logo and favicon</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {SLOTS.map((s) => <FileCard key={s.slot} {...s} url={s.slot === 'light' ? data.logoLightUrl : s.slot === 'dark' ? data.logoDarkUrl : data.faviconUrl} />)}
        </div>
        <p className="text-xs text-[var(--text-tertiary)]">SVG files with scripts, event handlers or external references are refused. Images are shown through an image tag only.</p>
      </section>

      <section aria-labelledby="credit-h" className="space-y-3">
        <h2 id="credit-h" className="text-heading-3">Product credit</h2>
        <FeatureGate feature="branding" label="Hiding the Powered by VEQSIO credit">
          <div className="veqsio-card p-5 space-y-2">
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={data.stored.hideCredit} disabled={save.isPending} onChange={(e) => save.mutate({ hideCredit: e.target.checked }, { onError: (err) => toast((err as Error).message, 'error') })} className="mt-0.5" />
              <span>Hide &quot;Powered by VEQSIO&quot; in the footer</span>
            </label>
            <p className="text-xs text-[var(--text-tertiary)]">The link to the licence notices and the source code stays in the footer and on the About page.</p>
          </div>
        </FeatureGate>
        <p className="text-xs text-[var(--text-tertiary)]">Changing the logo, name and colours is free. Only removing the credit needs the Enterprise licence.</p>
      </section>

      <div>
        <button type="button" className="veqsio-btn-secondary" disabled={reset.isPending}
          onClick={async () => (await confirmDialog('Reset the name, colour, logos, favicon and footer links to the Veqsio defaults?')) && reset.mutate(undefined, { onSuccess: () => toast('Appearance reset to the defaults', 'success'), onError: (e) => toast((e as Error).message, 'error') })}>
          Reset to default
        </button>
      </div>
    </div>
  )
}

export default function AppearancePage() {
  const q = useAdminBranding()
  return (
    <AppLayout>
      <div className="space-y-4">
        <PageHeader title="Appearance" description="Make this installation look like yours: name, logo, favicon and accent colour." />
        {q.isLoading && <Spinner />}
        {q.error && <p role="alert" className="text-[var(--error)]">{(q.error as Error).message}</p>}
        {q.data && <Settings data={q.data} />}
      </div>
    </AppLayout>
  )
}
