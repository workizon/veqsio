/**
 * Layout of every e-mail the application sends. Built for e-mail clients, not browsers: tables, inline styles, no CSS variables, no flexbox
 * (Gmail and Outlook ignore them, which used to leave the button without a background), a plain-text twin, and a footer that says why the
 * message was sent. Templates keep using the small class vocabulary (`btn`, `meta`, `meta-row`, `meta-label`, `meta-value`); `inlineClasses` turns it into
 * inline styles, so no template needed to change.
 */
const C = { brand: '#2D54D8', brandDark: '#2444B0', ink: '#101828', text: '#344054', muted: '#667085', line: '#E6E9EF', bg: '#F4F5F7', soft: '#FAFBFC', ok: '#16A06A', warn: '#C77700', bad: '#D92D20' };

const VARS: Record<string, string> = {
  '--text-primary': C.ink, '--text-secondary': C.muted, '--brand-500': C.brand, '--brand-600': C.brandDark, '--success': C.ok, '--warning': C.warn, '--error': C.bad,
  '--surface-0': '#FFFFFF', '--surface-1': C.soft, '--surface-3': C.line, '--text-inverse': '#FFFFFF',
};

/** Replaces the template class vocabulary and any `var(--x)` with inline, e-mail-safe markup. Exported for the tests. */
export function inlineClasses(content: string): string {
  let s = content.replace(/var\((--[a-z0-9-]+)\)/g, (m, name) => VARS[name] ?? m);
  const btn = `display:inline-block;background:${C.brand};color:#FFFFFF;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:14px;font-weight:600;margin-top:12px`;
  s = s.replace(/class="btn"/g, `style="${btn}"`);
  s = s.replace(/<div class="meta-row">\s*<span class="meta-label">([\s\S]*?)<\/span>\s*<span class="meta-value">([\s\S]*?)<\/span>\s*<\/div>/g,
    (_m, label, value) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr><td style="padding:8px 0;font-size:13px;color:${C.muted};border-bottom:1px solid ${C.line};vertical-align:top;width:34%">${label}</td><td align="right" style="padding:8px 0;font-size:13px;font-weight:600;color:${C.ink};border-bottom:1px solid ${C.line};vertical-align:top">${value}</td></tr></table>`);
  s = s.replace(/<div class="meta"( style="([^"]*)")?>/g, (_m, _a, extra) => `<div style="background:${C.soft};border:1px solid ${C.line};border-radius:10px;padding:8px 16px;margin:16px 0;${extra ?? ''}">`);
  const pBase = `margin:0 0 14px;font-size:15px;line-height:1.6;color:${C.text}`;
  s = s.replace(/<p>/g, `<p style="${pBase}">`);
  s = s.replace(/<p style="([^"]*)">/g, (m, own) => (own.includes('font-size') ? m : `<p style="${pBase};${own}">`)); // paragraphs with their own style keep it, on top of the base
  s = s.replace(/<a ((?:(?!style=)[^>])*)>/g, `<a $1 style="color:${C.brand}">`); // plain links: brand colour (buttons already carry their own style)
  return s;
}

export function baseTemplate(
  title: string,
  content: string,
  footer?: { html: string; text: string },
): { html: string; text: string } {
  const body = inlineClasses(content);
  const foot = footer ?? {
    html: 'You are receiving this e-mail because of activity in Veqsio that concerns you.',
    text: 'You are receiving this e-mail because of activity in Veqsio that concerns you.',
  };
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="color-scheme" content="light"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:${C.bg};-webkit-text-size-adjust:100%">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}"><tr><td align="center" style="padding:28px 12px">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px">
    <tr><td style="background:#16171A;border-radius:12px 12px 0 0;padding:18px 28px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td bgcolor="${C.brand}" width="30" height="30" align="center" style="border-radius:7px;width:30px;height:30px;font:700 16px Arial,sans-serif;color:#FFFFFF">V</td>
        <td style="padding-left:11px;font:700 18px -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#FFFFFF;letter-spacing:.02em">VEQSIO</td>
      </tr></table>
    </td></tr>
    <tr><td style="background:#FFFFFF;border:1px solid ${C.line};border-top:0;border-radius:0 0 12px 12px;padding:30px 28px 20px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
      <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:${C.ink};font-weight:700">${escapeHtml(title)}</h1>
      ${body}
    </td></tr>
    <tr><td style="padding:18px 28px 0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:${C.muted};text-align:center">${foot.html}</td></tr>
  </table>
</td></tr></table></body></html>`;

  // The plain-text twin: links keep their address, block ends become line breaks.
  const plain = body
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, '$2 ($1)')
    .replace(/<\/(p|div|tr|h1)>/g, '\n').replace(/<br\s*\/?>/g, '\n').replace(/<\/td>\s*<td[^>]*>/g, ': ')
    .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const text = `Veqsio\n\n${title}\n\n${plain}\n\n--\n${foot.text}`;

  return { html, text };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
