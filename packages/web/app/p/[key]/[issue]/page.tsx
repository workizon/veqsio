import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PublicShell } from '@/components/public-shell'
import { RichText } from '@/components/rich-text'
import { absolute, publicConfig, publicGet, plainSummary, type PublicIssue } from '@/lib/public-api'

type Props = { params: Promise<{ key: string; issue: string }> }

async function load(issue: string) {
  const cfg = await publicConfig()
  const data = cfg.enabled ? await publicGet<PublicIssue>(`/rest/public/issues/${encodeURIComponent(issue)}`) : null
  return { cfg, data }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { issue } = await params
  const { cfg, data } = await load(issue)
  if (!data) return { title: 'Not found', robots: { index: false } }
  const title = `${data.key}: ${data.summary} · ${data.project.name}`
  const description = plainSummary(data.description) || `${data.type} in ${data.project.name}, status ${data.status}.`
  const path = `/p/${data.project.key}/${data.key}`
  return {
    title,
    description,
    robots: cfg.indexing === 'none' || data.indexable === false ? { index: false, follow: false } : { index: true, follow: true },
    alternates: { ...(cfg.baseUrl ? { canonical: `${cfg.baseUrl}${path}` } : {}), types: { 'text/markdown': `${path}/markdown` } },
    openGraph: { title, description, type: 'article', siteName: cfg.siteName, publishedTime: data.created, modifiedTime: data.updated, ...(cfg.baseUrl ? { url: `${cfg.baseUrl}${path}` } : {}) },
    twitter: { card: 'summary', title, description },
  }
}

export default async function PublicIssuePage({ params }: Props) {
  const { key, issue } = await params
  const { cfg, data } = await load(issue)
  if (!data || data.project.key !== key.toUpperCase()) notFound()
  const url = absolute(cfg, `/p/${data.project.key}/${data.key}`)
  // schema.org markup so search engines and assistants can read the thread structure.
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'DiscussionForumPosting',
    headline: `${data.key}: ${data.summary}`.slice(0, 110),
    text: plainSummary(data.description, 5000),
    url,
    datePublished: data.created,
    dateModified: data.updated,
    author: data.reporter ? { '@type': 'Person', name: data.reporter } : undefined,
    isPartOf: { '@type': 'WebSite', name: cfg.siteName },
    commentCount: data.comments.length,
    comment: data.comments.slice(0, 20).map((c) => ({ '@type': 'Comment', text: plainSummary(c.body, 1000), dateCreated: c.created, author: c.author ? { '@type': 'Person', name: c.author } : undefined })),
  }
  return (
    <PublicShell siteName={cfg.siteName}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }} />
      <nav aria-label="Breadcrumb" className="text-body-sm text-[var(--text-secondary)]">
        <Link href="/p" className="hover:underline">Projects</Link> / <Link href={`/p/${data.project.key}`} className="hover:underline">{data.project.name}</Link> / {data.key}
      </nav>
      <article className="mt-3">
        <h1 className="text-heading-1">{data.summary}</h1>
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-body-sm sm:grid-cols-4">
          {[['Type', data.type], ['Status', data.status], ['Priority', data.priority], ['Assignee', data.assignee], ['Reporter', data.reporter], ['Labels', data.labels.join(', ')], ['Fix versions', data.fixVersions.join(', ')], ['Updated', new Date(data.updated).toISOString().slice(0, 10)]]
            .filter(([, v]) => v).map(([k, v]) => (<div key={k as string}><dt className="text-[var(--text-tertiary)]">{k}</dt><dd>{v}</dd></div>))}
        </dl>
        {data.description && <RichText className="mt-6" value={data.description} />}
        <section aria-labelledby="comments-heading" className="mt-10">
          <h2 id="comments-heading" className="text-heading-3">Comments ({data.comments.length})</h2>
          <ol className="mt-3 space-y-4">
            {data.comments.map((c) => (
              <li key={c.id} className="rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] p-4">
                <div className="text-body-sm text-[var(--text-secondary)]"><strong className="text-[var(--text-primary)]">{c.author ?? 'Unknown'}</strong> · <time dateTime={c.created}>{new Date(c.created).toISOString().slice(0, 10)}</time></div>
                <RichText className="mt-2" value={c.body} />
              </li>
            ))}
          </ol>
        </section>
      </article>
    </PublicShell>
  )
}
