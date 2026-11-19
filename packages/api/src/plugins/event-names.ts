/**
 * Event names plugins may subscribe to. Leaf module (no imports) to avoid a cycle with services/webhooks.ts;
 * a unit test asserts it stays equal to the WebhookEvent list there.
 */
export const PLUGIN_EVENT_NAMES = [
  'issue.created',
  'issue.updated',
  'issue.deleted',
  'comment.added',
  'issue.transitioned',
  'sprint.started',
  'sprint.closed',
  'sla.breached',
  'sla.warning',
  'approval.requested',
  'approval.decided',
  'incident.major',
] as const;
