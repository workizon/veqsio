/** Knowledge base search for the portal: word-based ranking with a snippet around the best match (pure, no DB). */

const STOPWORDS = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one', 'our', 'out', 'has', 'have', 'how', 'with', 'this', 'that', 'from', 'what', 'when', 'where', 'who', 'why', 'will', 'would', 'could', 'should', 'does', 'did', 'cant', 'cannot', 'dont', 'need', 'want', 'help', 'please', 'issue', 'problem', 'my', 'me', 'is', 'it', 'to', 'of', 'in', 'on', 'at', 'a', 'an', 'i', 'we', 'be', 'do', 'or', 'no', 'so', 'if', 'as', 'by', 'up'])

/** Lower-case words of at least 3 letters or digits, without stop words, unique, at most 12. */
export function tokenize(q: string): string[] {
  const words = q.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter((w) => w.length >= 3 && !STOPWORDS.has(w))
  return [...new Set(words)].slice(0, 12)
}

export interface KbCandidate { id: number; title: string; body: string; labels: unknown; helpful: number; views: number }
export interface KbHit { id: number; title: string; labels: unknown; excerpt: string; score: number }

/** About 240 characters around the first occurrence of any token (or the start of the text). */
export function snippetAround(body: string, tokens: string[], max = 240): string {
  const text = body.replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  const lower = text.toLowerCase()
  let at = -1
  for (const t of tokens) { const i = lower.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i }
  const start = at < 0 ? 0 : Math.max(0, at - Math.floor(max / 3))
  const cut = text.slice(start, start + max).trim()
  return `${start > 0 ? '… ' : ''}${cut}${start + max < text.length ? ' …' : ''}`
}

/** Score = matching words (title matches count triple), then helpful votes and views as tie-breakers. Articles that match nothing are dropped. */
export function rankArticles(articles: KbCandidate[], q: string, limit = 10): KbHit[] {
  const tokens = tokenize(q)
  if (tokens.length === 0) return []
  const hits: Array<KbHit & { tie: number }> = []
  for (const a of articles) {
    const title = a.title.toLowerCase()
    const body = a.body.toLowerCase()
    let score = 0
    for (const t of tokens) { if (title.includes(t)) score += 3; if (body.includes(t)) score += 1 }
    if (score > 0) hits.push({ id: a.id, title: a.title, labels: a.labels, excerpt: snippetAround(a.body, tokens), score, tie: a.helpful * 10 + a.views })
  }
  return hits.sort((x, y) => y.score - x.score || y.tie - x.tie || x.title.localeCompare(y.title)).slice(0, limit).map(({ tie: _t, ...h }) => h)
}
