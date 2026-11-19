import { baseTemplate } from './base';

/** All string values arrive pre-escaped from email.ts (escapeTemplateData). */
export function filterDigestTemplate(data: {
  filterName: string;
  total: number;
  shown: number;
  issues: { key: string; summary: string; status: string; url: string }[];
  filterUrl: string;
}) {
  const rows = data.issues
    .map(
      (i) =>
        `<div class="meta-row"><span class="meta-label"><a href="${i.url}">${i.key}</a></span><span class="meta-value">${i.summary} <em>(${i.status})</em></span></div>`,
    )
    .join('\n      ');
  const more = data.total > data.shown ? `<p>Showing ${data.shown} of ${data.total} issues.</p>` : '';
  const content = `
    <p>Your subscription to the filter <strong>${data.filterName}</strong> found <strong>${data.total}</strong> issue${data.total === 1 ? '' : 's'}.</p>
    <div class="meta">
      ${rows || '<div class="meta-row"><span class="meta-value">No issues match this filter right now.</span></div>'}
    </div>
    ${more}
    <a href="${data.filterUrl}" class="btn">Open Filter</a>
  `;
  return baseTemplate('Filter subscription', content);
}
