import { baseTemplate } from './base';

export function sprintClosedTemplate(data: {
  sprintName: string;
  goal?: string;
  boardName: string;
  completedIssues: number;
  totalIssues: number;
  sprintUrl: string;
}) {
  const content = `
    <p>The sprint <strong>${data.sprintName}</strong> has been closed in <strong>${data.boardName}</strong>.</p>
    <div class="meta">
      <div class="meta-row"><span class="meta-label">Sprint</span><span class="meta-value">${data.sprintName}</span></div>
      ${data.goal ? `<div class="meta-row"><span class="meta-label">Goal</span><span class="meta-value">${data.goal}</span></div>` : ''}
      <div class="meta-row"><span class="meta-label">Completed</span><span class="meta-value">${data.completedIssues} / ${data.totalIssues}</span></div>
    </div>
    <a href="${data.sprintUrl}" class="btn">View Sprint Report</a>
  `;
  return baseTemplate(`Sprint Closed: ${data.sprintName}`, content);
}
