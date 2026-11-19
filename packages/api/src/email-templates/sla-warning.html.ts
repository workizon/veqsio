import { baseTemplate } from './base';

export function slaWarningTemplate(data: {
  issueKey: string;
  summary: string;
  projectName: string;
  slaName: string;
  targetText: string;
  remainingText: string;
  issueUrl: string;
}) {
  const content = `
    <p>The SLA <strong>${data.slaName}</strong> is about to be breached on a request in <strong>${data.projectName}</strong>: ${data.remainingText} left.</p>
    <div class="meta">
      <div class="meta-row"><span class="meta-label">Request</span><span class="meta-value">${data.issueKey}</span></div>
      <div class="meta-row"><span class="meta-label">Summary</span><span class="meta-value">${data.summary}</span></div>
      <div class="meta-row"><span class="meta-label">Target</span><span class="meta-value">${data.targetText}</span></div>
    </div>
    <a href="${data.issueUrl}" class="btn">Open Request</a>
  `;
  return baseTemplate(`SLA at risk: ${data.issueKey}`, content);
}
