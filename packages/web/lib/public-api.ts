/** Server-side access to the anonymous read-only API (`/rest/public/*`). Used by the public pages, sitemap, robots and llms.txt. */

const API = (process.env.API_INTERNAL_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3040').replace(/\/+$/, '')

export async function publicGet<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API}${path}`, { next: { revalidate: 60 } })
    return res.ok ? ((await res.json()) as T) : null
  } catch {
    return null
  }
}

export interface PublicConfig { enabled: boolean; indexing: 'all' | 'search' | 'none'; siteName: string; baseUrl: string }
export interface PublicProject { key: string; name: string; description: string | null; category: string | null; avatarUrl: string | null; issueCount: number; updated: string; indexable?: boolean; board?: boolean; roadmap?: boolean }
export interface PublicIssueRow { key: string; summary: string; type: string; status: string; statusCategory: string; priority: string | null; created: string; updated: string }
export interface PublicIssue {
  key: string; summary: string; description: string | null; project: { key: string; name: string }; indexable?: boolean
  type: string; status: string; statusCategory: string; priority: string | null; assignee: string | null; reporter: string | null
  labels: string[]; fixVersions: string[]; created: string; updated: string; resolved: string | null
  comments: Array<{ id: number; author: string | null; body: string; created: string }>
}

const FALLBACK: PublicConfig = { enabled: false, indexing: 'search', siteName: 'Veqsio', baseUrl: '' }
export async function publicConfig(): Promise<PublicConfig> {
  return (await publicGet<PublicConfig>('/rest/public/config')) ?? FALLBACK
}

/** Plain text for meta descriptions: markup and whitespace removed, cut at a word boundary. */
export function plainSummary(text: string | null | undefined, max = 160): string {
  const t = (text ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/[#*_`>\[\]{}|~]/g, ' ').replace(/\(https?:[^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  return t.slice(0, max).replace(/\s+\S*$/, '') + '…'
}

export const absolute = (cfg: PublicConfig, path: string) => (cfg.baseUrl ? `${cfg.baseUrl}${path}` : path)

export const AI_CRAWLERS = ['GPTBot', 'ClaudeBot', 'anthropic-ai', 'CCBot', 'Google-Extended', 'PerplexityBot', 'Bytespider', 'Applebot-Extended', 'cohere-ai', 'Meta-ExternalAgent', 'Amazonbot']

export interface PublicBoard { board: { name: string }; columns: Array<{ name: string; total: number; issues: Array<{ key: string; summary: string; type: string; priority: string | null }> }> }
export interface PublicRoadmap { versions: Array<{ name: string; description: string | null; startDate: string | null; releaseDate: string | null; released: boolean; issues: { total: number; done: number } }> }
