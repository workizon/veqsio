import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PublicShell } from '@/components/public-shell'
import { publicConfig, publicGet, absolute, type PublicBoard, type PublicProject } from '@/lib/public-api'

type Props = { params: Promise<{ key: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { key } = await params
  const cfg = await publicConfig()
  const project = cfg.enabled ? await publicGet<PublicProject>(`/rest/public/projects/${encodeURIComponent(key)}`) : null
  if (!project) return { title: 'Not found', robots: { index: false } }
  const index = cfg.indexing !== 'none' && project.indexable !== false
  return {
    title: `Board · ${project.name} · ${cfg.siteName}`,
    description: `What the team of ${project.name} is working on.`,
    robots: index ? { index: true, follow: true } : { index: false, follow: true },
    alternates: cfg.baseUrl ? { canonical: absolute(cfg, `/p/${project.key}/board`) } : undefined,
  }
}

/** Read-only board of a public project: the columns of its first board with the newest issues in each. */
export default async function PublicBoardPage({ params }: Props) {
  const { key } = await params
  const cfg = await publicConfig()
  if (!cfg.enabled) notFound()
  const project = await publicGet<PublicProject>(`/rest/public/projects/${encodeURIComponent(key)}`)
  const data = project ? await publicGet<PublicBoard>(`/rest/public/projects/${encodeURIComponent(project.key)}/board`) : null
  if (!project || !data) notFound()
  return (
    <PublicShell siteName={cfg.siteName}>
      <nav aria-label="Breadcrumb" className="text-body-sm text-[var(--text-secondary)]"><Link href="/p" className="hover:underline">Projects</Link> / <Link href={`/p/${project.key}`} className="hover:underline">{project.name}</Link> / Board</nav>
      <h1 className="mt-2 text-heading-1">{project.name}: {data.board.name}</h1>
      <p className="mt-1 text-body-sm text-[var(--text-secondary)]">Read-only. Newest issues first, up to 25 per column.</p>
      <div className="mt-5 flex gap-4 overflow-x-auto pb-4 snap-x snap-mandatory sm:snap-none" role="list" aria-label="Board columns">
        {data.columns.map((col) => (
          <section key={col.name} role="listitem" aria-label={col.name} className="w-[85vw] sm:w-72 shrink-0 snap-center rounded-lg border border-[var(--surface-3)] bg-[var(--surface-1)]">
            <h2 className="flex items-center justify-between border-b border-[var(--surface-3)] p-3 text-heading-3">{col.name}<span className="text-caption text-[var(--text-tertiary)]">{col.total}</span></h2>
            <ul className="space-y-2 p-2">
              {col.issues.map((i) => (
                <li key={i.key} className="rounded-md border border-[var(--surface-3)] bg-[var(--surface-0)] p-2.5">
                  <Link href={`/p/${project.key}/${i.key}`} className="line-clamp-2 text-body-sm font-medium hover:underline">{i.summary}</Link>
                  <p className="mt-1 text-caption text-[var(--text-tertiary)]">{i.key} · {i.type}{i.priority ? ` · ${i.priority}` : ''}</p>
                </li>
              ))}
              {col.total > col.issues.length && <li className="px-1 text-caption text-[var(--text-tertiary)]"><Link href={`/p/${project.key}`} className="hover:underline">and {col.total - col.issues.length} more in the project list</Link></li>}
              {col.total === 0 && <li className="px-1 text-caption text-[var(--text-tertiary)]">Nothing here.</li>}
            </ul>
          </section>
        ))}
      </div>
    </PublicShell>
  )
}
