import { baseTemplate } from './base';

export function slaBreachedTemplate(data: {
  issueKey: string;
  summary: string;
  projectName: string;
  slaName: string;
  targetText: string;
  issueUrl: string;
}) {
  const content = `
    <p>The SLA <strong>${data.slaName}</strong> was breached on a request in <strong>${data.projectName}</strong>.</p>
    <div class="meta">
      <div class="meta-row"><span class="meta-label">Request</span><span class="meta-value">${data.issueKey}</span></div>
      <div class="meta-row"><span class="meta-label">Summary</span><span class="meta-value">${data.summary}</span></div>
      <div class="meta-row"><span class="meta-label">Target</span><span class="meta-value">${data.targetText}</span></div>
    </div>
    <a href="${data.issueUrl}" class="btn">Open Request</a>
  `;
  return baseTemplate(`SLA Breached: ${data.issueKey}`, content);
}
