/**
 * Sentry intake. Understands the two webhook shapes Sentry sends to an internal integration / alert rule action:
 *  - issue alert (`Sentry-Hook-Resource: event_alert`): `data.event` + `data.triggered_rule`
 *  - issue webhook (`Sentry-Hook-Resource: issue`): `data.issue` with `action` created | resolved | assigned | ...
 * The signature (`Sentry-Hook-Signature`, hex HMAC-SHA256 of the raw body with the client secret) is verified by the caller.
 * Sentry text is untrusted: it is cut to length and control characters are removed.
 */
import { getPath, stringifyValue, stripControl } from './template';
import { cleanLabel, type Normalized } from './mapping';

export const SENTRY_SIGNATURE_HEADER = 'sentry-hook-signature';

/** Sentry level -> default priority name (matches the standard Veqsio priority scheme). */
export const SENTRY_LEVEL_PRIORITY: Record<string, string> = {
  fatal: 'Highest', error: 'High', warning: 'Medium', info: 'Low', debug: 'Lowest',
};

const str = (payload: unknown, path: string, max = 500) => stripControl(stringifyValue(getPath(payload, path))).trim().slice(0, max);
const safeUrl = (u: string) => (/^https?:\/\/[^\s<>"']+$/i.test(u) ? u : '');

export function normalizeSentry(payload: unknown, priorityMap: Record<string, string> = SENTRY_LEVEL_PRIORITY): Normalized | null {
  if (!payload || typeof payload !== 'object') return null;
  const action = str(payload, 'action', 40).toLowerCase();

  // Issue webhook: data.issue
  const issue = getPath(payload, 'data.issue');
  // Issue alert: data.event
  const event = getPath(payload, 'data.event');
  const node = issue && typeof issue === 'object' ? issue : event && typeof event === 'object' ? event : null;
  if (!node) return null;
  const isIssue = node === issue;
  // Assignments, archiving etc. on the issue webhook carry no news for the tracker.
  if (isIssue && !['created', 'resolved', 'unresolved'].includes(action)) return null;

  const id = isIssue ? str(payload, 'data.issue.id', 100) : (str(payload, 'data.event.issue_id', 100) || str(payload, 'data.event.groupID', 100));
  if (!id) return null;
  const title = (isIssue ? str(payload, 'data.issue.title') : (str(payload, 'data.event.title') || str(payload, 'data.event.message'))) || `Sentry issue ${id}`;
  const culprit = isIssue ? str(payload, 'data.issue.culprit') : str(payload, 'data.event.culprit');
  const level = (isIssue ? str(payload, 'data.issue.level', 20) : str(payload, 'data.event.level', 20)).toLowerCase();
  const link = safeUrl(isIssue
    ? (str(payload, 'data.issue.permalink', 1000) || str(payload, 'data.issue.web_url', 1000))
    : (str(payload, 'data.event.web_url', 1000) || str(payload, 'data.event.issue_url', 1000)));
  const rule = isIssue ? '' : str(payload, 'data.triggered_rule', 200);
  const project = isIssue ? str(payload, 'data.issue.project.slug', 100) : str(payload, 'data.event.project', 100);
  const env = isIssue ? '' : str(payload, 'data.event.environment', 100);
  const platform = isIssue ? str(payload, 'data.issue.platform', 50) : str(payload, 'data.event.platform', 50);

  const status = isIssue ? str(payload, 'data.issue.status', 20).toLowerCase() : '';
  const resolved = action === 'resolved' || status === 'resolved';

  const lines = [
    `Sentry reported: ${title}`,
    culprit && `Culprit: ${culprit}`,
    level && `Level: ${level}`,
    project && `Project: ${project}`,
    env && `Environment: ${env}`,
    platform && `Platform: ${platform}`,
    rule && `Alert rule: ${rule}`,
    link && `Sentry link: ${link}`,
  ].filter(Boolean) as string[];

  const labels = ['sentry'];
  if (level) labels.push(cleanLabel(`sentry-${level}`));
  if (env) labels.push(cleanLabel(`env-${env}`));

  const description = lines.join('\n');
  return {
    summary: title.split(/\r?\n/)[0].slice(0, 255),
    description,
    priority: level ? (priorityMap[level] ?? null) : null,
    labels: labels.filter(Boolean),
    dedupKey: `sentry:${id}`,
    resolved,
    comment: resolved ? 'Sentry marked this issue as resolved.' : `Sentry reported this again${rule ? ` (rule: ${rule})` : ''}.${link ? `\n${link}` : ''}`,
    idempotencyKey: null,
  };
}
