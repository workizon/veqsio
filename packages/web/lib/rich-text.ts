/**
 * Safe rich-text rendering for issue descriptions and comments.
 *
 * Input is untrusted text, either Markdown or Jira wiki markup (imported from Jira).
 * Output is an HTML string that is safe to inject: markdown-it runs with `html: false` (raw HTML is
 * escaped, never passed through), and links/images are restricted by an allowlist:
 *  - links: http(s), mailto, site-relative (`/path`) and in-page (`#anchor`);
 *    external links get target=_blank rel="noopener noreferrer nofollow"
 *  - images: http(s) or site-relative (`/path`, e.g. attachment URLs) only; no data:/javascript:/blob:
 * The only HTML we emit ourselves is a fixed set of tags with escaped attribute values.
 */
import MarkdownIt from 'markdown-it';
import { looksLikeWikiMarkup, wikiToMarkdown, type WikiOptions } from './wiki-markup';

export { looksLikeWikiMarkup, wikiToMarkdown };

export interface RenderOptions extends WikiOptions {
  /** Force a format instead of auto-detecting. */
  format?: 'markdown' | 'wiki' | 'auto';
}

type MD = InstanceType<typeof MarkdownIt>;
const MAX_LENGTH = 200_000;

export function isSafeLinkUrl(raw: string): boolean {
  const url = raw.trim();
  if (/[\u0000-\u001f\u007f\s]/.test(url)) return false;
  if (url.includes('\\')) return false; // `/\evil.com` is read by browsers as `//evil.com`
  return /^(https?:\/\/|mailto:)[^\s]/i.test(url) || /^\/(?!\/)/.test(url) || url.startsWith('#');
}

export function isSafeImageUrl(raw: string): boolean {
  const url = raw.trim();
  if (/[\u0000-\u001f\u007f\s]/.test(url)) return false;
  if (url.includes('\\')) return false;
  return /^https?:\/\/[^\s]/i.test(url) || /^\/(?!\/)/.test(url);
}

function createRenderer(): MD {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });
  md.validateLink = isSafeLinkUrl;
  const esc = md.utils.escapeHtml;

  const defaultLinkOpen = md.renderer.rules.link_open || ((tokens, idx, o, _e, self) => self.renderToken(tokens, idx, o));
  md.renderer.rules.link_open = (tokens, idx, o, env, self) => {
    const t = tokens[idx];
    const href = String(t.attrGet('href') ?? '');
    if (/^(https?:|mailto:)/i.test(href)) {
      t.attrSet('target', '_blank');
      t.attrSet('rel', 'noopener noreferrer nofollow');
    } else {
      t.attrSet('rel', 'nofollow');
    }
    return defaultLinkOpen(tokens, idx, o, env, self);
  };

  md.renderer.rules.image = (tokens, idx, o, env, self) => {
    const t = tokens[idx];
    const src = String(t.attrGet('src') ?? '');
    const alt = self.renderInlineAsText(t.children || [], o, env);
    if (!isSafeImageUrl(src)) return esc(alt ? `[image: ${alt}]` : '[image]');
    return `<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" referrerpolicy="no-referrer">`;
  };

  // Tables scroll horizontally on small screens.
  md.renderer.rules.table_open = () => '<div class="rt-table-wrap"><table>\n';
  md.renderer.rules.table_close = () => '</table></div>\n';

  // Task lists + @mentions.
  md.core.ruler.push('veqsio_inline_extras', (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type !== 'inline' || !t.children) continue;
      if (i >= 2 && tokens[i - 1].type === 'paragraph_open' && tokens[i - 2].type === 'list_item_open' && t.children.length) {
        const first = t.children[0];
        const m = first.type === 'text' ? first.content.match(/^\[([ xX])\]\s+/) : null;
        if (m) {
          first.content = first.content.slice(m[0].length);
          const cb = new state.Token('html_inline', '', 0);
          cb.content = `<input type="checkbox" disabled${m[1] === ' ' ? '' : ' checked'}> `;
          t.children.unshift(cb);
          tokens[i - 2].attrJoin('class', 'rt-task');
        }
      }
      const out: typeof t.children = [];
      let linkDepth = 0;
      for (const c of t.children) {
        if (c.type === 'link_open') linkDepth++;
        if (c.type === 'link_close') linkDepth--;
        if (c.type === 'text' && linkDepth === 0 && c.content.includes('@')) {
          const re = /(^|[\s(])@([A-Za-z0-9][\w.\-]{0,63})/g;
          let last = 0;
          let mm: RegExpExecArray | null;
          let found = false;
          while ((mm = re.exec(c.content))) {
            found = true;
            const start = mm.index + mm[1].length;
            if (start > last) {
              const tx = new state.Token('text', '', 0);
              tx.content = c.content.slice(last, start);
              out.push(tx);
            }
            const sp = new state.Token('html_inline', '', 0);
            sp.content = `<span class="rt-mention">@${esc(mm[2])}</span>`;
            out.push(sp);
            last = start + 1 + mm[2].length;
          }
          if (!found) out.push(c);
          else if (last < c.content.length) {
            const tx = new state.Token('text', '', 0);
            tx.content = c.content.slice(last);
            out.push(tx);
          }
        } else out.push(c);
      }
      t.children = out;
    }
  });
  return md;
}

let renderer: MD | null = null;

/** Render Markdown to safe HTML. */
export function renderMarkdown(src: string): string {
  renderer ??= createRenderer();
  return renderer.render(src.length > MAX_LENGTH ? src.slice(0, MAX_LENGTH) : src);
}

/** Render Markdown or Jira wiki markup (auto-detected) to safe HTML. */
export function renderRichText(src: string | null | undefined, opts: RenderOptions = {}): string {
  if (!src) return '';
  const format = opts.format ?? 'auto';
  const isWiki = format === 'wiki' || (format === 'auto' && looksLikeWikiMarkup(src));
  return renderMarkdown(isWiki ? wikiToMarkdown(src.slice(0, MAX_LENGTH), opts) : src);
}
