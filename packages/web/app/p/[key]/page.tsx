import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ProjectAvatar } from '@/components/project-avatar'
import { PublicShell } from '@/components/public-shell'
import { publicConfig, publicGet, plainSummary, absolute, type PublicIssueRow, type PublicProject } from '@/lib/public-api'

const PAGE_SIZE = 25
type Props = { params: Promise<{ key: string }>; searchParams: Promise<{ q?: string; page?: string }> }

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { key } = await params
  const { q, page } = await searchParams
  const cfg = await publicConfig()
  const project = cfg.enabled ? await publicGet<PublicProject>(`/rest/public/projects/${encodeURIComponent(key)}`) : null
  if (!project) return { title: 'Not found', robots: { index: false } }
  // Search result pages and deep pagination stay out of the index; the project page itself is the canonical entry.
  const index = cfg.indexing !== 'none' && project.indexable !== false && !q && (!page || page === '1')
  return {
    title: `${project.name} (${project.key}) · ${cfg.siteName}`,
    description: plainSummary(project.description) || `Public issues of ${project.name}.`,
    robots: index ? { index: true, follow: true } : { index: false, follow: true },
    alternates: cfg.baseUrl ? { canonical: `${cfg.baseUrl}/p/${project.key}` } : undefined,
    openGraph: { title: project.name, description: plainSummary(project.description), type: 'website', siteName: cfg.siteName },
  }
}

export default async function PublicProjectPage({ params, searchParams }: Props) {
  const { key } = await params
  const { q = '', page = '1' } = await searchParams
  const cfg = await publicConfig()
  if (!cfg.enabled) notFound()
  const project = await publicGet<PublicProject>(`/rest/public/projects/${encodeURIComponent(key)}`)
  if (!project) notFound()
  const pageNo = Math.max(Number(page) || 1, 1)
  const qs = new URLSearchParams({ startAt: String((pageNo - 1) * PAGE_SIZE), maxResults: String(PAGE_SIZE) })
  if (q) qs.set('q', q.slice(0, 200))
  const list = await publicGet<{ total: number; issues: PublicIssueRow[] }>(`/rest/public/projects/${encodeURIComponent(project.key)}/issues?${qs}`)
  const issues = list?.issues ?? []
  const total = list?.total ?? 0
  const pages = Math.max(Math.ceil(total / PAGE_SIZE), 1)
  const link = (n: number) => `/p/${project.key}?${new URLSearchParams({ ...(q ? { q } : {}), page: String(n) })}`
  // schema.org markup for the project page: a collection of issues inside the site, with a breadcrumb trail
  const url = absolute(cfg, `/p/${project.key}`)
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'CollectionPage', name: `${project.name} (${project.key})`, description: plainSummary(project.description, 300) || undefined, url, dateModified: project.updated, numberOfItems: project.issueCount, isPartOf: { '@type': 'WebSite', name: cfg.siteName, url: absolute(cfg, '/p') } },
      { '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Projects', item: absolute(cfg, '/p') }, { '@type': 'ListItem', position: 2, name: project.name, item: url }] },
    ],
  }
  return (
    <PublicShell siteName={cfg.siteName}>
      {project.indexable !== false && cfg.indexing !== 'none' && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }} />}
      <nav aria-label="Breadcrumb" className="text-body-sm text-[var(--text-secondary)]"><Link href="/p" className="hover:underline">Projects</Link> / {project.key}</nav>
      <div className="mt-2 flex items-center gap-3"><ProjectAvatar projectKey={project.key} name={project.name} src={project.avatarUrl} size={40} /><h1 className="text-heading-1">{project.name}</h1></div>
      {project.description && <p className="mt-2 max-w-3xl text-[var(--text-secondary)]">{plainSummary(project.description, 400)}</p>}
      {(project.board || project.roadmap) && (
        <nav aria-label="Project views" className="mt-4 flex gap-4 text-body-sm">
          {project.board && <Link href={`/p/${project.key}/board`} className="text-[var(--brand-600)] hover:underline">Board</Link>}
          {project.roadmap && <Link href={`/p/${project.key}/roadmap`} className="text-[var(--brand-600)] hover:underline">Roadmap</Link>}
        </nav>
      )}
      <form method="get" role="search" className="mt-6 flex gap-2">
        <input name="q" defaultValue={q} aria-label="Search issues" placeholder="Search by key or summary" className="veqsio-input flex-1" maxLength={200} />
        <button type="submit" className="veqsio-btn-secondary">Search</button>
      </form>
      <p className="mt-4 text-body-sm text-[var(--text-secondary)]">{total} issue{total === 1 ? '' : 's'}</p>
      <ul className="mt-2 divide-y divide-[var(--surface-3)] rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)]">
        {issues.map((i) => (
          <li key={i.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
            <Link href={`/p/${project.key}/${i.key}`} className="font-medium text-[var(--brand-600)] hover:underline">{i.key}</Link>
            <span className="min-w-0 flex-1">{i.summary}</span>
            <span className="text-caption text-[var(--text-tertiary)]">{i.type}</span>
            <span className={`rounded px-2 py-0.5 text-caption ${i.statusCategory === 'done' ? 'bg-green-100 text-green-800' : 'bg-[var(--surface-2)]'}`}>{i.status}</span>
          </li>
        ))}
        {issues.length === 0 && <li className="p-4 text-[var(--text-secondary)]">No issues found.</li>}
      </ul>
      {pages > 1 && (
        <nav aria-label="Pagination" className="mt-4 flex items-center gap-3 text-body-sm">
          {pageNo > 1 && <Link rel="prev" href={link(pageNo - 1)} className="text-[var(--brand-600)] hover:underline">Previous</Link>}
          <span>Page {pageNo} of {pages}</span>
          {pageNo < pages && <Link rel="next" href={link(pageNo + 1)} className="text-[var(--brand-600)] hover:underline">Next</Link>}
        </nav>
      )}
    </PublicShell>
  )
}
