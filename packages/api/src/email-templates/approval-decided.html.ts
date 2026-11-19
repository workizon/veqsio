import { baseTemplate } from './base';

/** Data arrives already HTML-escaped (see escapeTemplateData in services/email.ts). */
export function approvalDecidedTemplate(data: {
  issueKey: string;
  summary: string;
  projectName: string;
  approvalName: string;
  status: string;
  issueUrl: string;
}) {
  const content = `
    <p>The approval <strong>${data.approvalName}</strong> in <strong>${data.projectName}</strong> finished with the result <strong>${data.status}</strong>.</p>
    <div class="meta">
      <div class="meta-row"><span class="meta-label">Issue</span><span class="meta-value">${data.issueKey}</span></div>
      <div class="meta-row"><span class="meta-label">Summary</span><span class="meta-value">${data.summary}</span></div>
    </div>
    <a href="${data.issueUrl}" class="btn">Open issue</a>
  `;
  return baseTemplate('Approval completed', content);
}
