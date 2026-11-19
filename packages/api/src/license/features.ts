/**
 * Feature catalogue for the open-core licence.
 *
 * Everything that is NOT listed in ENTERPRISE_FEATURES is part of the AGPL community edition and is
 * always available. Features listed here need a valid licence key whose `features` (or `plan`) include them.
 * Keep this list short and stable: removing a name silently makes it free, adding one makes it paid.
 */
export const ENTERPRISE_FEATURES = [
  'sso_saml',
  'sso_oidc_generic',
  'scim',
  'ldap',
  'issue_security',
  'audit_export',
  'audit_retention',
  'ha_cluster',           // reserved: multi-node works in every edition
  'advanced_permissions', // reserved: nothing is gated by this name yet
  'itsm',               // incident, problem and change management
  'sla_automation',       // reserved: SLAs are free in every edition
  'assets_cmdb',
  'oncall',               // reserved: on-call schedules are free in every edition
  'module_timesheets',  // Tempo-like timesheets module
  'module_plans',       // Plans / advanced roadmaps module
  'branding',           // hide the "Powered by Veqsio" credit (custom logo, name and colours stay free)
  'priority_support',
] as const

export type EnterpriseFeature = (typeof ENTERPRISE_FEATURES)[number]

export type Plan = 'community' | 'team' | 'enterprise'

/** Features granted by a plan on top of the explicit `features` list in the key. */
export const PLAN_FEATURES: Record<Plan, readonly string[]> = {
  community: [],
  team: ['audit_export', 'issue_security', 'module_timesheets'],
  enterprise: ENTERPRISE_FEATURES,
}

const enterpriseSet = new Set<string>(ENTERPRISE_FEATURES)

export function isEnterpriseFeature(feature: string): boolean {
  return enterpriseSet.has(feature)
}

export function isPlan(value: unknown): value is Plan {
  return value === 'community' || value === 'team' || value === 'enterprise'
}

/** Human labels for the admin UI and refusal messages. */
export const FEATURE_LABELS: Record<EnterpriseFeature, string> = {
  sso_saml: 'SAML single sign-on',
  sso_oidc_generic: 'Generic OpenID Connect single sign-on',
  scim: 'SCIM user provisioning',
  ldap: 'LDAP directory sync',
  issue_security: 'Issue security levels',
  audit_export: 'Audit log export',
  audit_retention: 'Audit log retention',
  ha_cluster: 'High availability cluster',
  advanced_permissions: 'Advanced permissions',
  itsm: 'ITSM (incident, problem, change)',
  sla_automation: 'SLA automation',
  assets_cmdb: 'Assets and CMDB',
  oncall: 'On-call schedules',
  module_timesheets: 'Timesheets module',
  module_plans: 'Plans module',
  branding: 'White-label branding (hide the Powered by Veqsio credit)',
  priority_support: 'Priority support',
}

export function featureLabel(feature: string): string {
  return (FEATURE_LABELS as Record<string, string>)[feature] ?? feature
}

/** Cheapest plan that includes a feature ('enterprise' for anything not in a smaller plan). */
export function requiredPlan(feature: string): Plan {
  if (PLAN_FEATURES.team.includes(feature)) return 'team'
  return 'enterprise'
}

export function requiredPlanLabel(feature: string): string {
  return requiredPlan(feature) === 'team' ? 'Team or Enterprise' : 'Enterprise'
}
