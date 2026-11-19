import { baseTemplate } from './base';

export function issueUpdatedTemplate(data: {
  issueKey: string;
  summary: string;
  projectName: string;
  authorName: string;
  changes: Array<{ field: string; oldValue: string | null; newValue: string | null }>;
  issueUrl: string;
}) {
  const changesHtml = data.changes.map(c => {
    const oldVal = c.oldValue ?? '(none)';
    const newVal = c.newValue ?? '(none)';
    return `<div class="meta-row"><span class="meta-label">${c.field}</span><span class="meta-value">${oldVal} &rarr; ${newVal}</span></div>`;
  }).join('');

  const content = `
    <p><strong>${data.authorName}</strong> updated an issue in <strong>${data.projectName}</strong>.</p>
    <div class="meta">
      <div class="meta-row"><span class="meta-label">Issue</span><span class="meta-value">${data.issueKey}</span></div>
      <div class="meta-row"><span class="meta-label">Summary</span><span class="meta-value">${data.summary}</span></div>
      ${changesHtml}
    </div>
    <a href="${data.issueUrl}" class="btn">View Issue</a>
  `;
  return baseTemplate(`Issue Updated: ${data.issueKey}`, content);
}
