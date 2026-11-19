import type { MetadataRoute } from 'next'
import { AI_CRAWLERS, publicConfig } from '@/lib/public-api'

export const dynamic = 'force-dynamic'

const PRIVATE = ['/rest/', '/scim/', '/auth/', '/admin/', '/settings', '/projects/', '/issues', '/boards', '/backlog', '/portal/', '/servicedesk', '/m/']

export default async function robots(): Promise<MetadataRoute.Robots> {
  const cfg = await publicConfig()
  const sitemap = cfg.baseUrl && cfg.enabled && cfg.indexing !== 'none' ? `${cfg.baseUrl}/sitemap.xml` : undefined
  if (!cfg.enabled || cfg.indexing === 'none') return { rules: [{ userAgent: '*', disallow: '/' }] }
  const rules: MetadataRoute.Robots['rules'] = [{ userAgent: '*', allow: ['/p/', '/p', '/llms.txt'], disallow: PRIVATE }]
  // "search": regular search engines only; crawlers that collect training data are turned away.
  if (cfg.indexing === 'search') rules.push({ userAgent: AI_CRAWLERS, disallow: '/' })
  return { rules, sitemap }
}
