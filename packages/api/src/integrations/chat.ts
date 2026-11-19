/**
 * Chat notification messages: one neutral `ChatMessage` is built from an internal event payload and rendered for
 * Slack (Block Kit) or Microsoft Teams (Adaptive Card, or the legacy MessageCard). All user-supplied text is
 * escaped for the target format and capped, so an issue title cannot inject mentions, links or markup.
 */
import { stripControl } from './template';

export const CHAT_EVENTS = [
  'issue.created', 'issue.transitioned', 'comment.added', 'issue.assigned',
  'sprint.started', 'sprint.completed', 'release.published',
] as const;
export type ChatEvent = typeof CHAT_EVENTS[number];
export const isChatEvent = (e: string): e is ChatEvent => (CHAT_EVENTS as readonly string[]).includes(e);

export const CHAT_EVENT_LABELS: Record<ChatEvent, string> = {
  'issue.created': 'Issue created',
  'issue.transitioned': 'Issue transitioned',
  'comment.added': 'Comment added',
  'issue.assigned': 'Issue assigned',
  'sprint.started': 'Sprint started',
  'sprint.completed': 'Sprint completed',
  'release.published': 'Release published',
};

export interface ChatMessage {
  event: ChatEvent;
  /** Short headline, e.g. "Issue created". */
  headline: string;
  /** Main line: issue key + summary, sprint name, version name. */
  title: string;
  url?: string;
  project?: string;
  facts: Array<{ label: string; value: string }>;
  /** Longer text (comment body, sprint goal). */
  quote?: string;
}

const clip = (v: unknown, max: number) => {
  const s = stripControl(String(v ?? '')).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
};
const clipMulti = (v: unknown, max: number) => {
  const s = stripControl(String(v ?? '')).trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
};
const httpUrl = (u: unknown) => (typeof u === 'string' && /^https?:\/\/[^\s<>"'|]+$/i.test(u) ? u : undefined);

/** Which chat event (if any) a webhook-level event is. Plain updates are not offered. */
export function chatEventFor(event: string, payload: Record<string, any>): ChatEvent | null {
  switch (event) {
    case 'issue.created': return 'issue.created';
    case 'issue.transitioned': return 'issue.transitioned';
    case 'comment.added': return 'comment.added';
    case 'issue.updated': return payload.assignedTo ? 'issue.assigned' : null;
    case 'sprint.started': return 'sprint.started';
    case 'sprint.closed': return 'sprint.completed';
    case 'release.published': return 'release.published';
    default: return null;
  }
}

export function buildChatMessage(event: ChatEvent, p: Record<string, any>): ChatMessage {
  const issueTitle = `${clip(p.issueKey, 40)}: ${clip(p.summary, 200)}`;
  const facts: ChatMessage['facts'] = [];
  const add = (label: string, v: unknown) => { const s = clip(v, 120); if (s) facts.push({ label, value: s }); };
  const project = clip(p.projectName, 100) || undefined;

  switch (event) {
    case 'issue.created':
      add('Priority', p.priority); add('Assignee', p.assignee); add('Reporter', p.reporterName);
      return { event, headline: CHAT_EVENT_LABELS[event], title: issueTitle, url: httpUrl(p.issueUrl), project, facts };
    case 'issue.transitioned': {
      const st = Array.isArray(p.changes) ? p.changes.find((c: any) => c?.field === 'status') : null;
      if (st) add('Status', `${clip(st.oldValue, 60) || '—'} → ${clip(st.newValue, 60) || '—'}`);
      add('By', p.authorName);
      return { event, headline: CHAT_EVENT_LABELS[event], title: issueTitle, url: httpUrl(p.issueUrl), project, facts };
    }
    case 'comment.added':
      add('By', p.authorName);
      return { event, headline: CHAT_EVENT_LABELS[event], title: issueTitle, url: httpUrl(p.issueUrl), project, facts, quote: clipMulti(p.commentBody, 300) || undefined };
    case 'issue.assigned':
      add('Assigned by', p.assignerName); add('Priority', p.priority);
      return { event, headline: CHAT_EVENT_LABELS[event], title: issueTitle, url: httpUrl(p.issueUrl), project, facts };
    case 'sprint.started':
      add('Board', p.boardName); add('Start', p.startDate); add('End', p.endDate);
      return { event, headline: CHAT_EVENT_LABELS[event], title: clip(p.sprintName, 200), url: httpUrl(p.sprintUrl), project, facts, quote: clipMulti(p.goal, 300) || undefined };
    case 'sprint.completed':
      add('Board', p.boardName); add('Issues', p.completedIssues);
      return { event, headline: CHAT_EVENT_LABELS[event], title: clip(p.sprintName, 200), url: httpUrl(p.sprintUrl), project, facts, quote: clipMulti(p.goal, 300) || undefined };
    case 'release.published':
      add('Release date', p.releaseDate);
      return { event, headline: CHAT_EVENT_LABELS[event], title: clip(p.versionName, 200), url: httpUrl(p.url), project, facts, quote: clipMulti(p.description, 300) || undefined };
  }
}

/* ------------------------------- Slack ------------------------------- */

/** Slack mrkdwn control characters: & < > must be entity-encoded so text cannot become a link or @channel mention. */
export const slackEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function formatSlack(m: ChatMessage): Record<string, unknown> {
  const title = m.url ? `<${m.url}|${slackEscape(m.title)}>` : slackEscape(m.title);
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: m.headline.slice(0, 150), emoji: false } },
    { type: 'section', text: { type: 'mrkdwn', text: `*${title}*` } },
  ];
  if (m.facts.length) {
    blocks.push({ type: 'section', fields: m.facts.slice(0, 10).map((f) => ({ type: 'mrkdwn', text: `*${slackEscape(f.label)}*\n${slackEscape(f.value)}` })) });
  }
  if (m.quote) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: m.quote.split('\n').map((l) => `> ${slackEscape(l)}`).join('\n').slice(0, 2900) } });
  if (m.project) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Veqsio · ${slackEscape(m.project)}` }] });
  // `text` is the notification / accessibility fallback.
  return { text: slackEscape(`${m.headline}: ${m.title}`).slice(0, 300), blocks };
}

/* ------------------------------- Teams ------------------------------- */

/** Teams renders Markdown in TextBlock / MessageCard text; neutralise the characters that would change formatting or build links. */
export const teamsEscape = (s: string) => s.replace(/([\\`*_{}[\]()#+!|<>~])/g, '\\$1');

export type TeamsFormat = 'adaptive' | 'messagecard';

export function formatTeams(m: ChatMessage, format: TeamsFormat = 'adaptive'): Record<string, unknown> {
  if (format === 'messagecard') {
    return {
      '@type': 'MessageCard',
      '@context': 'https://schema.org/extensions',
      summary: `${m.headline}: ${m.title}`.slice(0, 200),
      themeColor: '0052CC',
      title: teamsEscape(m.headline),
      sections: [{
        activityTitle: teamsEscape(m.title),
        activitySubtitle: m.project ? teamsEscape(m.project) : undefined,
        facts: m.facts.map((f) => ({ name: teamsEscape(f.label), value: teamsEscape(f.value) })),
        text: m.quote ? teamsEscape(m.quote) : undefined,
        markdown: true,
      }],
      potentialAction: m.url ? [{ '@type': 'OpenUri', name: 'Open in Veqsio', targets: [{ os: 'default', uri: m.url }] }] : undefined,
    };
  }
  const body: unknown[] = [
    { type: 'TextBlock', text: teamsEscape(m.headline), weight: 'Bolder', size: 'Medium', wrap: true },
    { type: 'TextBlock', text: teamsEscape(m.title), wrap: true, spacing: 'Small' },
  ];
  if (m.facts.length) body.push({ type: 'FactSet', facts: m.facts.map((f) => ({ title: teamsEscape(f.label), value: teamsEscape(f.value) })) });
  if (m.quote) body.push({ type: 'TextBlock', text: teamsEscape(m.quote), wrap: true, isSubtle: true });
  if (m.project) body.push({ type: 'TextBlock', text: `Veqsio · ${teamsEscape(m.project)}`, isSubtle: true, size: 'Small', wrap: true });
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      contentUrl: null,
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body,
        actions: m.url ? [{ type: 'Action.OpenUrl', title: 'Open in Veqsio', url: m.url }] : undefined,
      },
    }],
  };
}

export const TEST_MESSAGE: ChatMessage = {
  event: 'issue.created',
  headline: 'Test message from Veqsio',
  title: 'If you can read this, the channel works.',
  facts: [{ label: 'Sent by', value: 'Veqsio notification channel test' }],
};
