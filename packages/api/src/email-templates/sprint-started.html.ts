import { baseTemplate } from './base';

export function sprintStartedTemplate(data: {
  sprintName: string;
  goal?: string;
  boardName: string;
  startDate?: string;
  endDate?: string;
  sprintUrl: string;
}) {
  const content = `
    <p>A new sprint has started in <strong>${data.boardName}</strong>.</p>
    <div class="meta">
      <div class="meta-row"><span class="meta-label">Sprint</span><span class="meta-value">${data.sprintName}</span></div>
      ${data.goal ? `<div class="meta-row"><span class="meta-label">Goal</span><span class="meta-value">${data.goal}</span></div>` : ''}
      ${data.startDate ? `<div class="meta-row"><span class="meta-label">Start</span><span class="meta-value">${data.startDate}</span></div>` : ''}
      ${data.endDate ? `<div class="meta-row"><span class="meta-label">End</span><span class="meta-value">${data.endDate}</span></div>` : ''}
    </div>
    <a href="${data.sprintUrl}" class="btn">View Sprint</a>
  `;
  return baseTemplate(`Sprint Started: ${data.sprintName}`, content);
}
