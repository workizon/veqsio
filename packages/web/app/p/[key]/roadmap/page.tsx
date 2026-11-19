import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PublicShell } from '@/components/public-shell'
import { publicConfig, publicGet, plainSummary, absolute, type PublicRoadmap, type PublicProject } from '@/lib/public-api'

type Props = { params: Promise<{ key: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { key } = await params
  const cfg = await publicConfig()
  const project = cfg.enabled ? await publicGet<PublicProject>(`/rest/public/projects/${encodeURIComponent(key)}`) : null
  if (!project) return { title: 'Not found', robots: { index: false } }
  const index = cfg.indexing !== 'none' && project.indexable !== false
  return {
    title: `Roadmap · ${project.name} · ${cfg.siteName}`,
    description: `Planned and released versions of ${project.name}.`,
    robots: index ? { index: true, follow: true } : { index: false, follow: true },
    alternates: cfg.baseUrl ? { canonical: absolute(cfg, `/p/${project.key}/roadmap`) } : undefined,
  }
}

const day = (d: string | null) => (d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) : null)

/** Read-only roadmap of a public project: its versions with release dates and how much of each is done. */
export default async function PublicRoadmapPage({ params }: Props) {
  const { key } = await params
  const cfg = await publicConfig()
  if (!cfg.enabled) notFound()
  const project = await publicGet<PublicProject>(`/rest/public/projects/${encodeURIComponent(key)}`)
  const data = project ? await publicGet<PublicRoadmap>(`/rest/public/projects/${encodeURIComponent(project.key)}/roadmap`) : null
  if (!project || !data) notFound()
  return (
    <PublicShell siteName={cfg.siteName}>
      <nav aria-label="Breadcrumb" className="text-body-sm text-[var(--text-secondary)]"><Link href="/p" className="hover:underline">Projects</Link> / <Link href={`/p/${project.key}`} className="hover:underline">{project.name}</Link> / Roadmap</nav>
      <h1 className="mt-2 text-heading-1">{project.name}: roadmap</h1>
      {data.versions.length === 0 && <p className="mt-4 text-[var(--text-secondary)]">No versions are planned yet.</p>}
      <ol className="mt-5 space-y-3">
        {data.versions.map((v) => {
          const pct = v.issues.total ? Math.round((v.issues.done / v.issues.total) * 100) : v.released ? 100 : 0
          return (
            <li key={v.name} className="rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] p-4">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <h2 className="text-heading-3">{v.name}</h2>
                <span className={`rounded px-2 py-0.5 text-caption ${v.released ? 'bg-green-100 text-green-800' : 'bg-[var(--surface-2)]'}`}>{v.released ? 'Released' : 'Planned'}</span>
                {day(v.releaseDate) && <span className="text-body-sm text-[var(--text-secondary)]">{v.released ? 'on' : 'target'} {day(v.releaseDate)}</span>}
              </div>
              {v.description && <p className="mt-1 text-body-sm text-[var(--text-secondary)]">{plainSummary(v.description, 300)}</p>}
              <div className="mt-3 flex items-center gap-3">
                <div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${v.name} progress`} className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--surface-3)]"><div className="h-full rounded-full bg-[var(--brand-500)]" style={{ width: `${pct}%` }} /></div>
                <span className="text-caption tabular-nums text-[var(--text-secondary)]">{v.issues.done} of {v.issues.total} done</span>
              </div>
            </li>
          )
        })}
      </ol>
    </PublicShell>
  )
}
