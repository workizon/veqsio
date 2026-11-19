import { db } from '../db';
import * as schema from '@veqsio/db';
import { eq, asc } from 'drizzle-orm';
import { issueCreatedTemplate } from '../email-templates/issue-created.html';
import { issueUpdatedTemplate } from '../email-templates/issue-updated.html';
import { commentAddedTemplate } from '../email-templates/comment-added.html';
import { issueAssignedTemplate } from '../email-templates/issue-assigned.html';
import { sprintStartedTemplate } from '../email-templates/sprint-started.html';
import { sprintClosedTemplate } from '../email-templates/sprint-closed.html';
import { mentionNotificationTemplate } from '../email-templates/mention-notification.html';
import { slaBreachedTemplate } from '../email-templates/sla-breached.html';
import { slaWarningTemplate } from '../email-templates/sla-warning.html';
import { filterDigestTemplate } from '../email-templates/filter-digest.html';
import { passwordResetTemplate } from '../email-templates/password-reset.html';
import { approvalRequestedTemplate } from '../email-templates/approval-requested.html';
import { approvalDecidedTemplate } from '../email-templates/approval-decided.html';
import { moduleNoticeTemplate } from '../email-templates/module-notice.html';
import { intakeDecidedTemplate } from '../email-templates/intake-decided.html';
import { intakeNewTemplate } from '../email-templates/intake-new.html';
import { requestUpdateTemplate } from '../email-templates/request-update.html';
import { createTransport, type Transporter } from 'nodemailer';
import { planLimits, emailBudget, emailsSentLastHour } from '../cloud/limits';

export type EmailTemplate =
  | 'issue-created'
  | 'issue-updated'
  | 'comment-added'
  | 'issue-assigned'
  | 'sprint-started'
  | 'sprint-closed'
  | 'mention-notification'
  | 'sla-breached'
  | 'sla-warning'
  | 'filter-digest'
  | 'password-reset'
  | 'approval-requested'
  | 'approval-decided'
  | 'module-notice'
  | 'intake-decided'
  | 'intake-new'
  | 'request-update';

interface SmtpConfig {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  from: string;
  tls?: boolean;
}

async function getDbSmtpConfig(): Promise<SmtpConfig | null> {
  try {
    const rows = await db.select().from(schema.systemSettings).where(eq(schema.systemSettings.key, 'mail_config'));
    if (!rows.length || !rows[0].value) return null;
    const parsed = JSON.parse(rows[0].value) as Partial<SmtpConfig>;
    if (!parsed.host || !parsed.port || !parsed.from) return null;
    return {
      host: parsed.host,
      port: Number(parsed.port),
      user: parsed.user,
      pass: parsed.pass,
      from: parsed.from,
      tls: parsed.tls,
    };
  } catch {
    return null;
  }
}

function getEnvSmtpConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined;
  const from = process.env.SMTP_FROM;
  if (!host || !port || !from) return null;
  return {
    host,
    port,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from,
    tls: process.env.SMTP_TLS === 'true',
  };
}

export async function getSmtpConfig(): Promise<SmtpConfig | null> {
  return (await getDbSmtpConfig()) ?? getEnvSmtpConfig();
}

let transportOverride: Pick<Transporter, 'sendMail'> | null = null;
/** Tests inject a capturing transport; pass null to restore SMTP. */
export function setMailTransportForTests(t: Pick<Transporter, 'sendMail'> | null): void {
  transportOverride = t;
}

export async function getTransporter(): Promise<Pick<Transporter, 'sendMail'> | null> {
  if (transportOverride) return transportOverride;
  const config = await getSmtpConfig();
  if (!config) return null;
  return createTransport({
    host: config.host,
    port: config.port,
    secure: config.tls ?? config.port === 465,
    auth: config.user && config.pass ? { user: config.user, pass: config.pass } : undefined,
  });
}

/** Header values must never contain line breaks (header injection). */
function singleLine(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').slice(0, 300);
}

function getTemplateSubject(template: EmailTemplate, data: Record<string, any>): string {
  return singleLine(subjectFor(template, data));
}

function subjectFor(template: EmailTemplate, data: Record<string, any>): string {
  switch (template) {
    case 'issue-created':
      return `Issue Created: ${data.issueKey}`;
    case 'issue-updated':
      return `Issue Updated: ${data.issueKey}`;
    case 'comment-added':
      return `New Comment on ${data.issueKey}`;
    case 'issue-assigned':
      return `Assigned to You: ${data.issueKey}`;
    case 'sprint-started':
      return `Sprint Started: ${data.sprintName}`;
    case 'sprint-closed':
      return `Sprint Closed: ${data.sprintName}`;
    case 'mention-notification':
      return `You were mentioned in ${data.issueKey}`;
    case 'sla-breached':
      return `SLA Breached: ${data.issueKey}`;
    case 'sla-warning':
      return `SLA at risk: ${data.issueKey}`;
    case 'filter-digest':
      return `Filter subscription: ${data.filterName}`;
    case 'password-reset':
      return 'Reset your Veqsio password';
    case 'approval-requested':
      return `${data.reminder ? 'Reminder: approval' : 'Approval requested'}: ${data.issueKey}`;
    case 'approval-decided':
      return `Approval ${data.status}: ${data.issueKey}`;
    case 'module-notice':
      return String(data.subject ?? data.heading ?? 'Veqsio notification');
    case 'request-update':
      return String(data.subject ?? `[${data.issueKey}] ${data.summary ?? ''}`);
    case 'intake-new':
      return `New intake submission: ${String(data.title ?? '').slice(0, 120)}`;
    case 'intake-decided':
      return `Your submission was ${data.decision === 'accepted' ? 'accepted' : 'declined'}: ${String(data.title ?? '').slice(0, 120)}`;
    default:
      return 'Veqsio Notification';
  }
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Templates interpolate values straight into HTML. Many values (summaries, comments, display names) are
 * user-controlled - including customers on the service desk portal - so every string is escaped here.
 */
export function escapeTemplateData<T>(value: T): T {
  if (typeof value === 'string') return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]) as unknown as T;
  if (Array.isArray(value)) return value.map(escapeTemplateData) as unknown as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, escapeTemplateData(v)])) as T;
  }
  return value;
}

const decodeEntities = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

function renderTemplate(template: EmailTemplate, rawData: Record<string, any>): { html: string; text: string } {
  const out = renderEscaped(template, escapeTemplateData(rawData));
  return { html: out.html, text: decodeEntities(out.text) };
}

function renderEscaped(template: EmailTemplate, data: Record<string, any>): { html: string; text: string } {
  switch (template) {
    case 'issue-created':
      return issueCreatedTemplate(data as Parameters<typeof issueCreatedTemplate>[0]);
    case 'issue-updated':
      return issueUpdatedTemplate(data as Parameters<typeof issueUpdatedTemplate>[0]);
    case 'comment-added':
      return commentAddedTemplate(data as Parameters<typeof commentAddedTemplate>[0]);
    case 'issue-assigned':
      return issueAssignedTemplate(data as Parameters<typeof issueAssignedTemplate>[0]);
    case 'sprint-started':
      return sprintStartedTemplate(data as Parameters<typeof sprintStartedTemplate>[0]);
    case 'sprint-closed':
      return sprintClosedTemplate(data as Parameters<typeof sprintClosedTemplate>[0]);
    case 'mention-notification':
      return mentionNotificationTemplate(data as Parameters<typeof mentionNotificationTemplate>[0]);
    case 'sla-breached':
      return slaBreachedTemplate(data as Parameters<typeof slaBreachedTemplate>[0]);
    case 'sla-warning':
      return slaWarningTemplate(data as Parameters<typeof slaWarningTemplate>[0]);
    case 'filter-digest':
      return filterDigestTemplate(data as Parameters<typeof filterDigestTemplate>[0]);
    case 'password-reset':
      return passwordResetTemplate(data as Parameters<typeof passwordResetTemplate>[0]);
    case 'approval-requested':
      return approvalRequestedTemplate(data as Parameters<typeof approvalRequestedTemplate>[0]);
    case 'approval-decided':
      return approvalDecidedTemplate(data as Parameters<typeof approvalDecidedTemplate>[0]);
    case 'module-notice':
      return moduleNoticeTemplate(data as Parameters<typeof moduleNoticeTemplate>[0]);
    case 'intake-new':
      return intakeNewTemplate(data as Parameters<typeof intakeNewTemplate>[0]);
    case 'intake-decided':
      return intakeDecidedTemplate(data as Parameters<typeof intakeDecidedTemplate>[0]);
    case 'request-update':
      return requestUpdateTemplate(data as Parameters<typeof requestUpdateTemplate>[0]);
    default:
      return { html: '<p>Veqsio notification</p>', text: 'Veqsio notification' };
  }
}

export async function sendEmail(to: string, template: EmailTemplate, data: Record<string, any>): Promise<void> {
  const { html, text } = renderTemplate(template, data);
  const subject = getTemplateSubject(template, data);

  await db.insert(schema.emailQueue).values({
    toAddress: to,
    subject,
    htmlBody: html,
    textBody: text,
    status: 'pending',
    retryCount: 0,
  });
}

export async function queueEmails(tos: string[], template: EmailTemplate, data: Record<string, any>): Promise<void> {
  if (tos.length === 0) return;
  const { html, text } = renderTemplate(template, data);
  const subject = getTemplateSubject(template, data);

  const values = tos.map((to) => ({
    toAddress: to,
    subject,
    htmlBody: html,
    textBody: text,
    status: 'pending' as const,
    retryCount: 0,
  }));

  await db.insert(schema.emailQueue).values(values);
}

/** Queue one mail with extra headers (threading). `subject` in data overrides the template subject. */
export async function queueEmailWithHeaders(
  to: string, template: EmailTemplate, data: Record<string, any>, headers: Record<string, string>,
): Promise<void> {
  const { html, text } = renderTemplate(template, data);
  const subject = getTemplateSubject(template, data);
  await db.insert(schema.emailQueue).values({
    toAddress: to, subject, htmlBody: html, textBody: text, status: 'pending', retryCount: 0, headers,
  });
}

export async function sendEmailDirect(to: string, template: EmailTemplate, data: Record<string, any>): Promise<void> {
  const transport = await getTransporter();
  if (!transport) {
    console.warn('[email] SMTP not configured, skipping direct send');
    return;
  }
  const { html, text } = renderTemplate(template, data);
  const subject = getTemplateSubject(template, data);
  const config = await getSmtpConfig();

  await transport.sendMail({
    from: config?.from ?? 'veqsio@localhost',
    to,
    subject,
    text,
    html,
  });
}

export async function processEmailQueue(batchSize = 10): Promise<{ sent: number; failed: number }> {
  const pending = await db
    .select()
    .from(schema.emailQueue)
    .where(eq(schema.emailQueue.status, 'pending'))
    .orderBy(asc(schema.emailQueue.createdAt))
    .limit(batchSize);

  const transport = await getTransporter();
  if (!transport) {
    console.warn('[email] SMTP not configured, cannot process queue');
    return { sent: 0, failed: 0 };
  }
  // plan cap on outgoing e-mail (abuse guard on managed tenants): leave the rest queued for the next hour
  const cap = planLimits().emailsPerHour;
  if (cap !== null) {
    const budget = emailBudget(cap, await emailsSentLastHour(), pending.length);
    if (budget === 0 && pending.length) { console.warn(`[email] hourly limit of ${cap} reached, ${pending.length} queued`); return { sent: 0, failed: 0 }; }
    pending.length = budget;
  }

  const fromAddress = (await getSmtpConfig())?.from ?? 'veqsio@localhost';
  let sent = 0;
  let failed = 0;

  for (const item of pending) {
    try {
      await transport.sendMail({
        from: fromAddress,
        to: item.toAddress,
        subject: item.subject,
        text: item.textBody,
        html: item.htmlBody,
        ...(item.headers && typeof item.headers === 'object' ? { headers: item.headers as Record<string, string> } : {}),
      });
      await db
        .update(schema.emailQueue)
        .set({ status: 'sent', sentAt: new Date() })
        .where(eq(schema.emailQueue.id, item.id));
      sent++;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const newRetry = (item.retryCount || 0) + 1;
      const status = newRetry >= 3 ? 'failed' : 'pending';
      await db
        .update(schema.emailQueue)
        .set({ status, retryCount: newRetry, errorMessage })
        .where(eq(schema.emailQueue.id, item.id));
      failed++;
    }
  }

  return { sent, failed };
}
