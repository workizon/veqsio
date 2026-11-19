import type { MetadataRoute } from 'next'
import { publicConfig, publicGet } from '@/lib/public-api'

export const dynamic = 'force-dynamic'

interface SitemapData { projects: Array<{ key: string; updated: string }>; issues: Array<{ key: string; project: string; updated: string }>; pages: number }

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const cfg = await publicConfig()
  if (!cfg.enabled || cfg.indexing === 'none' || !cfg.baseUrl) return []
  const first = await publicGet<SitemapData>('/rest/public/sitemap?page=0')
  if (!first) return []
  const entries: MetadataRoute.Sitemap = [{ url: `${cfg.baseUrl}/p`, changeFrequency: 'daily', priority: 0.8 }]
  for (const p of first.projects) entries.push({ url: `${cfg.baseUrl}/p/${p.key}`, lastModified: p.updated, changeFrequency: 'daily', priority: 0.7 })
  const add = (d: SitemapData) => { for (const i of d.issues) entries.push({ url: `${cfg.baseUrl}/p/${i.project}/${i.key}`, lastModified: i.updated, changeFrequency: 'weekly', priority: 0.5 }) }
  add(first)
  // Up to 10 pages of 5000 issues each (the sitemap protocol allows 50000 URLs per file).
  for (let page = 1; page < Math.min(first.pages, 10); page++) {
    const next = await publicGet<SitemapData>(`/rest/public/sitemap?page=${page}`)
    if (!next) break
    add(next)
  }
  return entries.slice(0, 50000)
}
