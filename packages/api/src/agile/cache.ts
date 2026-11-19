import { invalidateCache, invalidateIssueCache } from '../middleware/cache'

/** Drop cached agile reports (burnup, version, release burndown...) after an issue or version change. */
export async function invalidateAgileReports(): Promise<void> {
  await invalidateCache('veqsio:cache:*:/rest/agile/1.0/board/*/report/*')
}

/** Drop cached board/sprint/search responses after a sprint or planning change. */
export async function invalidateAgileCaches(issueKeys: readonly string[] = []): Promise<void> {
  await Promise.all([
    invalidateCache('veqsio:cache:*:/rest/agile/1.0/*'),
    invalidateCache('veqsio:cache:*:/rest/api/2/board*'),
    invalidateCache('veqsio:cache:*:/rest/api/2/sprint*'),
    invalidateIssueCache(),
    ...issueKeys.map((k) => invalidateIssueCache(k)),
  ])
}
