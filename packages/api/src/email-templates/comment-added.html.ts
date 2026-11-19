import { baseTemplate } from './base';

export function commentAddedTemplate(data: {
  issueKey: string;
  summary: string;
  projectName: string;
  authorName: string;
  commentBody: string;
  issueUrl: string;
}) {
  const content = `
    <p><strong>${data.authorName}</strong> commented on <strong>${data.issueKey}</strong> in <strong>${data.projectName}</strong>.</p>
    <div class="meta">
      <div class="meta-row"><span class="meta-label">Issue</span><span class="meta-value">${data.issueKey}</span></div>
      <div class="meta-row"><span class="meta-label">Summary</span><span class="meta-value">${data.summary}</span></div>
    </div>
    <div class="meta" style="margin-top:12px;">
      <p style="margin:0; font-style:italic; color:var(--text-primary);">${data.commentBody}</p>
    </div>
    <a href="${data.issueUrl}" class="btn">View Comment</a>
  `;
  return baseTemplate(`New Comment on ${data.issueKey}`, content);
}
