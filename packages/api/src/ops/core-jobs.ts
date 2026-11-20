import { processEmailQueue } from '../services/email';
import { checkSla } from '../servicedesk/breach';
import { runDeskAutomations } from '../servicedesk/automation';
import { runFilterDigests } from '../services/filter-digest';
import { runApprovalJobs } from '../approvals/reminders';
import { wakeSnoozed } from '../intake/service';
import { pollDueDesks } from '../servicedesk/imap-poller';
import { runDueDirectorySyncs } from '../auth/ldap-service';
import { runDueRecurring } from '../recurring/service';
import { runOncallEscalation } from '../oncall/escalation';
import { runAuditRetention } from '../audit/retention';
import { runUsageReport } from '../telemetry/report';
import { defineJob, type JobDef } from './jobs';

/**
 * The core scheduler table. Every entry runs under a PostgreSQL advisory lock (ops/jobs.ts), so two nodes with
 * VEQSIO_ROLE=all never execute the same job at the same time; with VEQSIO_ROLE=web none of them starts.
 */
export function coreJobs(): JobDef<any>[] {
  return [
    defineJob({ name: 'email-queue', everyMs: 30_000, run: () => processEmailQueue(10),
      describe: (r) => (r.sent > 0 || r.failed > 0) && `[email] Queue processed: ${r.sent} sent, ${r.failed} failed` }),
    defineJob({ name: 'sla-breach', everyMs: 60_000, run: () => checkSla(),
      describe: (r) => (r.breached > 0 || r.warned > 0) && `[servicedesk] ${r.breached} SLA breach and ${r.warned} SLA warning notification(s) sent` }),
    defineJob({ name: 'servicedesk-automation', everyMs: 60_000, run: () => runDeskAutomations(),
      describe: (n) => n > 0 && `[servicedesk] ${n} automation rule action(s) ran` }),
    defineJob({ name: 'filter-digest', everyMs: 5 * 60_000, run: () => runFilterDigests(),
      describe: (r) => (r.sent > 0 || r.failed > 0) && `[filter-digest] ${r.sent} queued, ${r.skippedEmpty} empty, ${r.failed} failed` }),
    defineJob({ name: 'intake-snooze', everyMs: 60_000, run: () => wakeSnoozed(),
      describe: (n) => n > 0 && `[intake] ${n} snoozed item(s) are pending again` }),
    defineJob({ name: 'approvals', everyMs: 5 * 60_000, run: () => runApprovalJobs(),
      describe: (r) => (r.expired > 0 || r.reminded > 0) && `[approvals] ${r.expired} expired, ${r.reminded} reminder(s) sent` }),
    defineJob({ name: 'servicedesk-imap', everyMs: 30_000, run: () => pollDueDesks(),
      describe: (n) => n > 0 && `[servicedesk-imap] polled ${n} mailbox(es)` }),
    defineJob({ name: 'ldap-sync', everyMs: 60_000, run: () => runDueDirectorySyncs(),
      describe: (n) => n > 0 && `[ldap] synced ${n} director${n === 1 ? 'y' : 'ies'}` }),
    defineJob({ name: 'recurring-issues', everyMs: 60_000, run: () => runDueRecurring(),
      describe: (r) => (r.created > 0 || r.failed > 0) && `[recurring] ${r.created} issue(s) created, ${r.skipped} skipped, ${r.failed} failed` }),
    defineJob({ name: 'audit-retention', everyMs: 6 * 3_600_000, run: () => runAuditRetention(),
      describe: (n) => n > 0 && `[audit] ${n} audit entr${n === 1 ? 'y' : 'ies'} past the retention period deleted` }),
    defineJob({ name: 'usage-stats', everyMs: 6 * 3_600_000, run: () => runUsageReport(),
      describe: (r) => r === 'sent' && '[usage-stats] anonymous usage report sent' }),
    defineJob({ name: 'oncall-escalation', everyMs: 60_000, run: () => runOncallEscalation(),
      describe: (n) => n > 0 && `[oncall] ${n} unacknowledged alert(s) escalated` }),
  ];
}
