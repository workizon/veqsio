import { baseTemplate } from './base';

/** Data arrives already HTML-escaped (see escapeTemplateData in services/email.ts). `reason` and `issueKey` may be empty strings. */
export function intakeDecidedTemplate(data: {
  projectName: string;
  title: string;
  decision: string;
  requesterName: string;
  reason: string;
  issueKey: string;
}) {
  const greeting = data.requesterName ? `Hello ${data.requesterName},` : 'Hello,';
  const body = data.decision === 'accepted'
    ? `<p>Your submission <strong>${data.title}</strong> to <strong>${data.projectName}</strong> was accepted and is now being tracked.</p>`
    : `<p>Your submission <strong>${data.title}</strong> to <strong>${data.projectName}</strong> was declined.</p>`;
  const reason = data.reason ? `<div class="meta"><div class="meta-row"><span class="meta-label">Note</span><span class="meta-value">${data.reason}</span></div></div>` : '';
  const key = data.issueKey ? `<div class="meta"><div class="meta-row"><span class="meta-label">Reference</span><span class="meta-value">${data.issueKey}</span></div></div>` : '';
  const content = `<p>${greeting}</p>${body}${reason}${key}`;
  return baseTemplate(data.decision === 'accepted' ? 'Submission accepted' : 'Submission declined', content);
}
