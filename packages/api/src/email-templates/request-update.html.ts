import { baseTemplate } from './base';

/**
 * Customer-facing mail about a service desk request (agent reply, status change, merge, "raised on your behalf").
 * All string values arrive already HTML-escaped (see escapeTemplateData in services/email.ts); the plain-text
 * part is decoded again by the caller. The footer is transactional: no unsubscribe/preferences link.
 */
export function requestUpdateTemplate(data: {
  kind: 'comment' | 'status' | 'merged' | 'created';
  issueKey: string;
  summary: string;
  deskName: string;
  authorName?: string;
  body?: string;
  statusName?: string;
  mergedInto?: string;
  requestUrl: string;
  replyHint?: boolean;
}) {
  const intro =
    data.kind === 'comment' ? `<strong>${data.authorName ?? 'Support'}</strong> replied to your request <strong>${data.issueKey}</strong>.`
    : data.kind === 'status' ? `The status of your request <strong>${data.issueKey}</strong> changed to <strong>${data.statusName ?? ''}</strong>.`
    : data.kind === 'merged' ? `Your request <strong>${data.issueKey}</strong> was merged into <strong>${data.mergedInto ?? ''}</strong>, which now tracks this issue.`
    : `A request was raised on your behalf${data.authorName ? ` by <strong>${data.authorName}</strong>` : ''}: <strong>${data.issueKey}</strong>.`;
  const introText =
    data.kind === 'comment' ? `${data.authorName ?? 'Support'} replied to your request ${data.issueKey}.`
    : data.kind === 'status' ? `The status of your request ${data.issueKey} changed to ${data.statusName ?? ''}.`
    : data.kind === 'merged' ? `Your request ${data.issueKey} was merged into ${data.mergedInto ?? ''}, which now tracks this issue.`
    : `A request was raised on your behalf${data.authorName ? ` by ${data.authorName}` : ''}: ${data.issueKey}.`;

  const bodyHtml = data.body
    ? `<div class="meta" style="margin-top:12px;"><p style="margin:0; color:var(--text-primary);">${data.body.replace(/\r?\n/g, '<br/>')}</p></div>`
    : '';
  const hint = data.replyHint ? '<p>You can reply to this email to add a comment to the request.</p>' : '';
  const content = `
    <p>${intro}</p>
    <div class="meta">
      <div class="meta-row"><span class="meta-label">Request</span><span class="meta-value">${data.issueKey}</span></div>
      <div class="meta-row"><span class="meta-label">Summary</span><span class="meta-value">${data.summary}</span></div>
    </div>
    ${bodyHtml}
    ${hint}
    <a href="${data.requestUrl}" class="btn">View request</a>
  `;

  const footer = {
    html: `This message is about your request ${data.issueKey} with ${data.deskName}. It is a service message, so there is nothing to unsubscribe from.`,
    text: `This message is about your request ${data.issueKey} with ${data.deskName}. It is a service message, so there is nothing to unsubscribe from.`,
  };
  const { html } = baseTemplate(`[${data.issueKey}] ${data.summary}`, content, footer);
  const text = [
    introText,
    '',
    `Request: ${data.issueKey}`,
    `Summary: ${data.summary}`,
    ...(data.body ? ['', data.body] : []),
    '',
    ...(data.replyHint ? ['You can reply to this email to add a comment to the request.', ''] : []),
    `View request: ${data.requestUrl}`,
    '',
    '--',
    footer.text,
  ].join('\n');
  return { html, text };
}
