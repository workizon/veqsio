import { baseTemplate } from './base';

/** Data arrives already HTML-escaped (see escapeTemplateData in services/email.ts). */
export function intakeNewTemplate(data: { projectName: string; title: string; source: string; link: string; more: string }) {
  const more = data.more ? `<p>More submissions may be waiting; this is the only email for the next 10 minutes.</p>` : '';
  const content = `<p>A new submission is waiting for triage in <strong>${data.projectName}</strong>.</p>
<div class="meta"><div class="meta-row"><span class="meta-label">Title</span><span class="meta-value">${data.title}</span></div><div class="meta-row"><span class="meta-label">Source</span><span class="meta-value">${data.source}</span></div></div>
<p><a href="${data.link}">Open the intake queue</a></p>${more}`;
  return baseTemplate('New intake submission', content);
}
