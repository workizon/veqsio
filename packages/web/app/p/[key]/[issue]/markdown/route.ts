import { publicConfig, publicGet, absolute, type PublicIssue } from '@/lib/public-api'

export const dynamic = 'force-dynamic'

/** The same issue as Markdown: compact, link-friendly, easy for assistants and scripts to read. */
export async function GET(_req: Request, { params }: { params: Promise<{ key: string; issue: string }> }) {
  const { key, issue } = await params
  const cfg = await publicConfig()
  const data = cfg.enabled ? await publicGet<PublicIssue>(`/rest/public/issues/${encodeURIComponent(issue)}`) : null
  if (!data || data.project.key !== key.toUpperCase()) return new Response('Not found', { status: 404 })
  const lines = [
    `# ${data.key}: ${data.summary}`,
    '',
    `- Project: ${data.project.name} (${data.project.key})`,
    `- Type: ${data.type}`,
    `- Status: ${data.status}`,
    ...(data.priority ? [`- Priority: ${data.priority}`] : []),
    ...(data.assignee ? [`- Assignee: ${data.assignee}`] : []),
    ...(data.reporter ? [`- Reporter: ${data.reporter}`] : []),
    ...(data.labels.length ? [`- Labels: ${data.labels.join(', ')}`] : []),
    ...(data.fixVersions.length ? [`- Fix versions: ${data.fixVersions.join(', ')}`] : []),
    `- Created: ${data.created}`,
    `- Updated: ${data.updated}`,
    `- URL: ${absolute(cfg, `/p/${data.project.key}/${data.key}`)}`,
    '',
    '## Description',
    '',
    data.description?.trim() || '_No description._',
    '',
    `## Comments (${data.comments.length})`,
  ]
  for (const c of data.comments) lines.push('', `### ${c.author ?? 'Unknown'}, ${c.created}`, '', c.body.trim())
  return new Response(lines.join('\n') + '\n', {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'public, max-age=60', ...(cfg.indexing === 'none' || data.indexable === false ? { 'X-Robots-Tag': 'noindex' } : {}) },
  })
}
