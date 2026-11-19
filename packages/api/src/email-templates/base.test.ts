import { describe, expect, test } from 'bun:test';
import { baseTemplate, inlineClasses } from './base';
import { passwordResetTemplate } from './password-reset.html';
import { issueAssignedTemplate } from './issue-assigned.html';

describe('e-mail layout is safe for e-mail clients', () => {
  const sample = passwordResetTemplate({ displayName: 'Ann', resetUrl: 'https://a.test/reset?t=1&x=2', expiresInMinutes: 60 });
  test('no CSS variables, no flexbox, the button carries its own background', () => {
    expect(sample.html).not.toContain('var(--');
    expect(sample.html).not.toContain('display:flex');
    expect(sample.html).toContain('background:#2D54D8;color:#FFFFFF');
    expect(sample.html).not.toContain('class="btn"');
  });
  test('the password reset mail no longer claims you are watching an issue', () => {
    expect(sample.html).not.toContain('watching an issue');
    expect(sample.text).not.toContain('watching an issue');
    expect(sample.html).toContain('password reset was requested');
  });
  test('the plain-text twin keeps the link and the wording', () => {
    expect(sample.text).toContain('Reset Password (https://a.test/reset?t=1&x=2)');
    expect(sample.text).toContain('This link expires in 60 minutes');
  });
  test('detail rows become table rows with label and value', () => {
    const out = inlineClasses('<div class="meta"><div class="meta-row"><span class="meta-label">Issue</span><span class="meta-value">ABC-1</span></div></div>');
    expect(out).toContain('<table'); expect(out).toContain('>Issue</td>'); expect(out).toContain('>ABC-1</td>'); expect(out).not.toContain('meta-row');
  });
  test('notification templates still render with their details', () => {
    const t = issueAssignedTemplate({ displayName: 'Ann', issueKey: 'ABC-7', summary: 'Fix <login>', priority: 'High', issueUrl: 'https://a.test/i/ABC-7', assignerName: 'Bob' } as any);
    expect(t.html).toContain('ABC-7'); expect(t.html).not.toContain('var(--'); expect(t.text).toContain('ABC-7');
  });
  test('baseTemplate keeps its signature and escapes the title', () => {
    expect(baseTemplate('A <b>', '<p>x</p>').html).toContain('A &lt;b&gt;');
  });
});
