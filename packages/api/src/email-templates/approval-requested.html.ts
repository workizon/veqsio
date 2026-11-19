import { baseTemplate } from './base';

/** Data arrives already HTML-escaped (see escapeTemplateData in services/email.ts). */
export function approvalRequestedTemplate(data: {
  issueKey: string;
  summary: string;
  projectName: string;
  approvalName: string;
  requesterName: string;
  reminder?: boolean;
  approvalsUrl: string;
}) {
  const content = `
    <p>${data.reminder ? 'Reminder: your' : 'Your'} decision is needed on <strong>${data.approvalName}</strong>, requested by ${data.requesterName} in <strong>${data.projectName}</strong>.</p>
    <div class="meta">
      <div class="meta-row"><span class="meta-label">Request</span><span class="meta-value">${data.issueKey}</span></div>
      <div class="meta-row"><span class="meta-label">Summary</span><span class="meta-value">${data.summary}</span></div>
    </div>
    <a href="${data.approvalsUrl}" class="btn">Review approval</a>
  `;
  return baseTemplate(data.reminder ? 'Approval reminder' : 'Approval requested', content);
}
