import { baseTemplate } from './base';
import { escapeHtml } from '../auth/reset-token';

export function passwordResetTemplate(data: {
  displayName: string;
  resetUrl: string;
  expiresInMinutes: number;
}) {
  const name = escapeHtml(String(data.displayName ?? ''));
  const url = escapeHtml(String(data.resetUrl ?? ''));
  const minutes = Number(data.expiresInMinutes) || 60;
  const content = `
    <p>Hi ${name},</p>
    <p>We received a request to reset the password for your Veqsio account. Click the button below to choose a new password. This link expires in ${minutes} minutes and can be used only once.</p>
    <a href="${url}" class="btn">Reset Password</a>
    <p style="margin-top:16px">If the button does not work, copy and paste this link into your browser:<br/>${url}</p>
    <p>If you did not request a password reset, you can safely ignore this email.</p>
  `;
  return baseTemplate('Reset your Veqsio password', content, {
    html: 'You received this e-mail because a password reset was requested for your Veqsio account.',
    text: 'You received this e-mail because a password reset was requested for your Veqsio account.',
  });
}
