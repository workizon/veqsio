import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ProjectAvatar } from '@/components/project-avatar'
import { PublicShell } from '@/components/public-shell'
import { publicConfig, publicGet, plainSummary, type PublicProject } from '@/lib/public-api'

export async function generateMetadata(): Promise<Metadata> {
  const cfg = await publicConfig()
  return {
    title: `Public projects · ${cfg.siteName}`,
    description: `Browse the public projects of ${cfg.siteName}: issues, status and discussion, no account needed.`,
    robots: cfg.enabled && cfg.indexing !== 'none' ? { index: true, follow: true } : { index: false, follow: false },
    alternates: cfg.baseUrl ? { canonical: `${cfg.baseUrl}/p` } : undefined,
  }
}

export default async function PublicProjectsPage() {
  const cfg = await publicConfig()
  if (!cfg.enabled) notFound()
  const data = await publicGet<{ projects: PublicProject[] }>('/rest/public/projects')
  const projects = data?.projects ?? []
  return (
    <PublicShell siteName={cfg.siteName}>
      <h1 className="text-heading-1">Public projects</h1>
      {projects.length === 0 ? <p className="mt-4 text-[var(--text-secondary)]">There are no public projects yet.</p> : (
        <ul className="mt-6 grid gap-4 sm:grid-cols-2">
          {projects.map((p) => (
            <li key={p.key} className="rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] p-4">
              <div className="flex items-center gap-3">
                <ProjectAvatar projectKey={p.key} name={p.name} src={p.avatarUrl} size={32} />
                <div>
                  <Link href={`/p/${p.key}`} className="text-heading-3 text-[var(--brand-600)] hover:underline">{p.name}</Link>
                  <span className="ml-2 text-caption text-[var(--text-tertiary)]">{p.key} · {p.issueCount} issues</span>
                </div>
              </div>
              {p.description && <p className="mt-1 text-body-sm text-[var(--text-secondary)]">{plainSummary(p.description, 200)}</p>}
            </li>
          ))}
        </ul>
      )}
    </PublicShell>
  )
}
