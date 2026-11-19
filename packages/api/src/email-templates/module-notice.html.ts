import { baseTemplate } from './base';

/**
 * Generic notice used by modules: a heading, a few lines of text, an optional issue and a link.
 * Data arrives already HTML-escaped (see escapeTemplateData in services/email.ts).
 */
export function moduleNoticeTemplate(data: {
  heading: string;
  lines?: string[];
  issueKey?: string;
  summary?: string;
  url?: string;
  actionLabel?: string;
}) {
  const lines = Array.isArray(data.lines) ? data.lines : [];
  const content = `
    <p><strong>${data.heading}</strong></p>
    ${lines.map((l) => `<p>${l}</p>`).join('\n')}
    ${data.issueKey ? `<div class="meta">
      <div class="meta-row"><span class="meta-label">Issue</span><span class="meta-value">${data.issueKey}</span></div>
      ${data.summary ? `<div class="meta-row"><span class="meta-label">Summary</span><span class="meta-value">${data.summary}</span></div>` : ''}
    </div>` : ''}
    ${data.url ? `<a href="${data.url}" class="btn">${data.actionLabel || 'Open'}</a>` : ''}
  `;
  return baseTemplate(data.heading, content);
}
