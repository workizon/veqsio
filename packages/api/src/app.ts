import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { compress } from 'hono/compress';
import { sessionMiddleware } from './auth/middleware';
import { rateLimitMiddleware } from './middleware/rate-limit';
import { securityHeaders } from './middleware/security-headers';
import { sanitizeDbErrors } from './middleware/error-sanitizer';
import { csrfGuard, bodyGuard, numericIdGuard } from './middleware/request-guards';
import authRoutes from './routes/auth';
import issueRoutes from './routes/issues';
import issueHistoryRoutes from './routes/issue-history';
import bulkRoutes from './routes/bulk';
import workflowRoutes from './routes/workflow';
import projectRoutes from './routes/projects';
import userRoutes from './routes/users';
import groupRoutes from './routes/groups';
import metadataRoutes from './routes/metadata';
import commentRoutes from './routes/comments';
import attachmentRoutes from './routes/attachments';
import voteRoutes from './routes/votes';
import watcherRoutes from './routes/watchers';
import filterRoutes from './routes/filters';
import dashboardRoutes from './routes/dashboards';
import permissionRoutes from './routes/permissions';
import searchRoutes from './routes/search';
import jqlAutocompleteRoutes from './routes/jql-autocomplete';
import projectAdminRoutes from './routes/project-admin';
import projectConfigRoutes from './routes/project-config';
import adminReportRoutes from './routes/admin-reports';
import notificationRoutes from './routes/notifications';
import migrationRoutes from './routes/migration';
import systemAdminRoutes from './routes/system-admin';
import opsAdminRoutes from './routes/ops-admin';
import { maintenanceMode } from './middleware/maintenance';
import { pathGuard } from './middleware/path-guard';
import licenseRoutes from './routes/license';
import brandingRoutes from './routes/branding';
import adminSchemeRoutes from './routes/admin-schemes';
import prioritySchemeRoutes from './routes/priority-schemes';
import pushRoutes from './routes/push';
import projectSchemeRoutes from './routes/project-schemes';
import oncallRoutes from './routes/oncall';
import oncallAlertRoutes from './routes/oncall-alerts';
import adminIssueTypeRoutes from './routes/admin-issuetypes';
import teamspaceRoutes from './routes/teamspaces';
import customerRoutes from './routes/customers';
import adminWorkflowRoutes from './routes/admin-workflows';
import ssoRoutes from './routes/sso';
import oidcRoutes from './routes/oidc';
import samlRoutes from './routes/saml';
import ldapRoutes from './routes/ldap';
import scimRoutes from './routes/scim';
import { tokenScopes } from './middleware/token-scopes';
import automationRoutes from './routes/automation';
import tokenRoutes from './routes/tokens';
import appLinkRoutes from './routes/application-links';
import worklogRoutes from './routes/worklogs';
import boardRoutes from './routes/boards';
import serviceDeskRoutes from './routes/servicedesk';
import serviceDeskSlaRoutes from './routes/servicedesk-sla';
import serviceDeskAutomationRoutes from './routes/servicedesk-automation';
import serviceDeskCannedRoutes from './routes/servicedesk-canned';
import serviceDeskEmailRoutes from './routes/servicedesk-email';
import serviceDeskAttachmentRoutes from './routes/servicedesk-attachments';
import serviceDeskAgentRoutes from './routes/servicedesk-agent';
import migrationRestRoutes from './routes/migration-rest';
import migrationToolsRoutes from './routes/migration-tools';
import agileReportRoutes from './routes/agile-reports';
import sprintPlanningRoutes from './routes/sprint-planning';
import csvImportRoutes from './routes/csv-import';
import adminHealthCheckRoutes from './routes/admin-health-check'
import adminHelperRoutes from './routes/admin-helpers';
import jqlRoutes from './routes/jql';
import pluginRoutes from './routes/plugins';
import agentRoutes from './routes/agents';
import scmRoutes from './routes/scm';
import integrationRoutes from './routes/integrations';
import pagesRoutes from './routes/pages';
import viewsRoutes from './routes/views';
import featureRoutes from './routes/features';
import statusUpdateRoutes from './routes/status-updates';
import initiativeRoutes from './routes/initiatives';
import milestoneRoutes from './routes/milestones';
import releaseRoutes from './routes/releases';
import publicRoutes from './routes/public';
import intakeRoutes from './routes/intake';
import instanceSettingsRoutes from './routes/instance-settings';
import issueTemplateRoutes from './routes/issue-templates';
import recurringIssueRoutes from './routes/recurring-issues';
import projectLifecycleRoutes from './routes/project-lifecycle';
import { archiveGuard } from './projects/archive-guard';
import { featureGate } from './features';
import labelRoutes from './routes/labels';
import approvalRoutes from './routes/approvals';
import auditLogRoutes from './routes/audit-log';
import { auditMiddleware } from './audit/log';
import type { AppContext } from './auth/middleware';
import realtimeRoutes from './routes/realtime';
import aiRoutes from './routes/ai';
import moduleHostRoutes from './modules/host';
import opsRoutes from './routes/ops';
import { requestLog, requestUserContext } from './middleware/request-log';
import { logger } from './ops/logger';
import { buildOpenApi } from './openapi/spec';
import { issueSecurityGuard } from './security/guard';
import { demoMode } from './middleware/demo-mode';
import { cloudMode } from './cloud/mode';
import cloudRoutes from './routes/cloud';
import adminIssueSecurityRoutes from './routes/admin-issue-security';

const app = new Hono<AppContext>();

app.use('*', pathGuard()); // refuses %XX-encoded letters and digits in the path (guards would see a different path than the router)
app.use('*', requestLog()); // request id, structured access log, HTTP metrics
app.use('*', securityHeaders());
app.use('*', sanitizeDbErrors());
app.use('*', cors({ origin: process.env.WEB_URL || 'http://localhost:3001', credentials: true, exposeHeaders: ['X-Request-Id'] }));
app.use('*', compress());
app.use('*', csrfGuard());
app.use('*', bodyGuard());
app.use('*', numericIdGuard());
app.use('*', sessionMiddleware);
app.use('*', requestUserContext());
app.use('*', tokenScopes());
app.use('*', archiveGuard()); // archived projects are read-only (409)
app.use('*', auditMiddleware);
app.use('*', featureGate());
app.use('*', issueSecurityGuard());
app.use('*', maintenanceMode()); // maintenance mode: everybody but system administrators gets a 503 with the message
app.use('*', cloudMode()); // managed tenants (VEQSIO_CLOUD=1): licence paste, backups, mail server, deployment pages are refused
app.use('*', demoMode()); // public demo only (VEQSIO_DEMO=1): refuses outgoing and system functions
app.use('*', rateLimitMiddleware());

// Liveness (touches nothing). Readiness (/ready) and Prometheus (/metrics) live in routes/ops.ts.
app.get('/health', (c) => c.json({ status: 'ok' }));

// OpenAPI 3.1 description of this API, generated from the route table (public, contains no instance data).
let openApiDoc: ReturnType<typeof buildOpenApi> | null = null;
app.get('/rest/api/2/openapi.json', (c) => {
  openApiDoc ??= buildOpenApi(app.routes);
  c.header('Cache-Control', 'public, max-age=300');
  return c.json(openApiDoc);
});

// Mount routes
app.route('/', aiRoutes); // before issueRoutes: /issue/similar and /issue/ai/* must not be shadowed
app.route('/', auditLogRoutes);
app.route('/', systemAdminRoutes);
app.route('/', opsAdminRoutes);
app.route('/', licenseRoutes);
app.route('/', brandingRoutes);
app.route('/', adminSchemeRoutes);
app.route('/', prioritySchemeRoutes);
app.route('/', pushRoutes);
app.route('/', projectSchemeRoutes);
app.route('/', oncallRoutes);
app.route('/', oncallAlertRoutes);
app.route('/', adminIssueTypeRoutes);
app.route('/', teamspaceRoutes);
app.route('/', customerRoutes);
app.route('/', adminWorkflowRoutes);
app.route('/', adminIssueSecurityRoutes);
app.route('/', authRoutes);
app.route('/', issueRoutes);
app.route('/', issueHistoryRoutes);
app.route('/', bulkRoutes);
app.route('/', workflowRoutes);
app.route('/', projectLifecycleRoutes);
app.route('/', projectRoutes);
app.route('/', userRoutes);
app.route('/', groupRoutes);
app.route('/', metadataRoutes);
app.route('/', commentRoutes);
app.route('/', attachmentRoutes);
app.route('/', voteRoutes);
app.route('/', watcherRoutes);
app.route('/', filterRoutes);
app.route('/', dashboardRoutes);
app.route('/', permissionRoutes);
app.route('/', searchRoutes);
app.route('/', jqlAutocompleteRoutes);
app.route('/', projectAdminRoutes);
app.route('/', projectConfigRoutes);
app.route('/', adminReportRoutes);
app.route('/', notificationRoutes);
app.route('/', migrationRoutes);
app.route('/', automationRoutes);
app.route('/', ssoRoutes);
app.route('/', oidcRoutes);
app.route('/', samlRoutes);
app.route('/', ldapRoutes);
app.route('/', scimRoutes);
app.route('/', tokenRoutes);
app.route('/', appLinkRoutes);
app.route('/', worklogRoutes);
app.route('/', boardRoutes);
app.route('/', serviceDeskRoutes);
app.route('/', serviceDeskSlaRoutes);
app.route('/', serviceDeskCannedRoutes);
app.route('/', serviceDeskAutomationRoutes);
app.route('/', serviceDeskEmailRoutes);
app.route('/', serviceDeskAttachmentRoutes);
app.route('/', serviceDeskAgentRoutes);
app.route('/', migrationRestRoutes);
app.route('/', migrationToolsRoutes);
app.route('/', agileReportRoutes);
app.route('/', sprintPlanningRoutes);
app.route('/', csvImportRoutes);
app.route('/', adminHealthCheckRoutes);
app.route('/', adminHelperRoutes);
app.route('/', realtimeRoutes);
app.route('/', jqlRoutes);
app.route('/', pluginRoutes);
app.route('/', agentRoutes);
app.route('/', scmRoutes);
app.route('/', integrationRoutes);
app.route('/', pagesRoutes);
app.route('/', viewsRoutes);
app.route('/', featureRoutes);
app.route('/', statusUpdateRoutes);
app.route('/', initiativeRoutes);
app.route('/', milestoneRoutes);
app.route('/', releaseRoutes);
app.route('/', intakeRoutes); // before publicRoutes: its /rest/public/* cache header must not apply to the intake form
app.route('/', publicRoutes);
app.route('/', instanceSettingsRoutes);
app.route('/', labelRoutes);
app.route('/', moduleHostRoutes);
app.route('/', approvalRoutes);
app.route('/', issueTemplateRoutes);
app.route('/', recurringIssueRoutes);
app.route('/', opsRoutes);
app.route('/', cloudRoutes);

// 404 handler
app.notFound((c) => c.json({ errorMessages: ['Resource not found'] }, 404));

// Error handler
app.onError((err, c) => {
  logger.error('unhandled error', { method: c.req.method, route: c.req.routePath, error: err });
  const leaky = /Failed query:|\bparams:/i.test(err.message || '');
  return c.json({ errorMessages: [leaky ? 'Internal server error' : err.message || 'Internal server error'] }, 500);
});

export default app;
