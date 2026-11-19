import { publicConfig, publicGet, plainSummary, type PublicProject } from '@/lib/public-api'

export const dynamic = 'force-dynamic'

/** llms.txt: a short map of the public content for language-model tools. Only served when the administrator allows all crawlers. */
export async function GET() {
  const cfg = await publicConfig()
  if (!cfg.enabled || cfg.indexing !== 'all') return new Response('Not found', { status: 404 })
  const data = await publicGet<{ projects: PublicProject[] }>('/rest/public/projects')
  const projects = data?.projects ?? []
  const lines = [
    `# ${cfg.siteName}`,
    '',
    `> Public projects of ${cfg.siteName}: issues, status and discussion. Every issue page has a Markdown version at \`/p/<PROJECT>/<ISSUE>/markdown\`.`,
    '',
    '## Projects',
    '',
    ...projects.map((p) => `- [${p.name} (${p.key})](${cfg.baseUrl}/p/${p.key}): ${plainSummary(p.description, 160) || `${p.issueCount} issues`}`),
    '',
    '## Optional',
    '',
    `- [Sitemap](${cfg.baseUrl}/sitemap.xml)`,
  ]
  return new Response(lines.join('\n') + '\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' } })
}
