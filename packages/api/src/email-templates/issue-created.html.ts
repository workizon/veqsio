import { baseTemplate } from './base';

export function issueCreatedTemplate(data: {
  issueKey: string;
  summary: string;
  projectName: string;
  reporterName: string;
  issueUrl: string;
  priority?: string;
  assignee?: string;
}) {
  const content = `
    <p>A new issue has been created in <strong>${data.projectName}</strong>.</p>
    <div class="meta">
      <div class="meta-row"><span class="meta-label">Issue</span><span class="meta-value">${data.issueKey}</span></div>
      <div class="meta-row"><span class="meta-label">Summary</span><span class="meta-value">${data.summary}</span></div>
      <div class="meta-row"><span class="meta-label">Reporter</span><span class="meta-value">${data.reporterName}</span></div>
      ${data.priority ? `<div class="meta-row"><span class="meta-label">Priority</span><span class="meta-value">${data.priority}</span></div>` : ''}
      ${data.assignee ? `<div class="meta-row"><span class="meta-label">Assignee</span><span class="meta-value">${data.assignee}</span></div>` : ''}
    </div>
    <a href="${data.issueUrl}" class="btn">View Issue</a>
  `;
  return baseTemplate(`Issue Created: ${data.issueKey}`, content);
}
