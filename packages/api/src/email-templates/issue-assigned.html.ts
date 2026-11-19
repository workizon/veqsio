import { baseTemplate } from './base';

export function issueAssignedTemplate(data: {
  issueKey: string;
  summary: string;
  projectName: string;
  assignerName: string;
  issueUrl: string;
  priority?: string;
}) {
  const content = `
    <p><strong>${data.assignerName}</strong> assigned an issue to you in <strong>${data.projectName}</strong>.</p>
    <div class="meta">
      <div class="meta-row"><span class="meta-label">Issue</span><span class="meta-value">${data.issueKey}</span></div>
      <div class="meta-row"><span class="meta-label">Summary</span><span class="meta-value">${data.summary}</span></div>
      ${data.priority ? `<div class="meta-row"><span class="meta-label">Priority</span><span class="meta-value">${data.priority}</span></div>` : ''}
    </div>
    <a href="${data.issueUrl}" class="btn">View Issue</a>
  `;
  return baseTemplate(`Assigned to You: ${data.issueKey}`, content);
}
