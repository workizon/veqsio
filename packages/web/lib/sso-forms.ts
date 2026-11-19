/** Pure helpers for the SAML and LDAP administration forms and the sign-in page. No React, no network. */

/** Splits a free-text list (commas, spaces, semicolons or new lines) into unique, trimmed entries. */
export function splitList(text: string, opts: { lower?: boolean } = {}): string[] {
  const out: string[] = []
  for (const raw of text.split(/[,;\n\r]+/)) {
    const v = (opts.lower ? raw.toLowerCase() : raw).trim()
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

/** Domains may be separated by spaces as well. */
export function splitDomains(text: string): string[] {
  return splitList(text.replace(/\s+/g, ','), { lower: true })
}

export const NAMEID_FORMATS: { value: string; label: string }[] = [
  { value: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress', label: 'Email address' },
  { value: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent', label: 'Persistent identifier' },
  { value: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified', label: 'Unspecified' },
  { value: 'urn:oasis:names:tc:SAML:1.1:nameid-format:X509SubjectName', label: 'X.509 subject name' },
]

export interface SamlForm {
  id?: number
  name: string
  slug: string
  idpEntityId: string
  idpSsoUrl: string
  idpCertificates: string
  signRequests: boolean
  spSigningKey: string
  spSigningCertificate: string
  hasSigningKey: boolean
  nameIdFormat: string
  emailAttribute: string
  displayNameAttribute: string
  usernameAttribute: string
  groupsAttribute: string
  syncGroups: boolean
  defaultGroups: string
  allowedDomains: string
  autoProvision: boolean
  linkByEmail: boolean
  enforceSso: boolean
  enabled: boolean
}

export const emptySamlForm: SamlForm = {
  name: '', slug: '', idpEntityId: '', idpSsoUrl: '', idpCertificates: '', signRequests: false, spSigningKey: '', spSigningCertificate: '', hasSigningKey: false,
  nameIdFormat: NAMEID_FORMATS[0].value, emailAttribute: '', displayNameAttribute: '', usernameAttribute: '', groupsAttribute: '',
  syncGroups: false, defaultGroups: '', allowedDomains: '', autoProvision: false, linkByEmail: false, enforceSso: false, enabled: true,
}

/** Request body for create (slug included) or update (slug omitted). Empty attribute names mean "use the defaults" (null). */
export function samlPayload(f: SamlForm): Record<string, unknown> {
  const nullable = (s: string) => s.trim() || null
  const body: Record<string, unknown> = {
    name: f.name.trim(),
    idpEntityId: f.idpEntityId.trim(),
    idpSsoUrl: f.idpSsoUrl.trim(),
    idpCertificates: f.idpCertificates.trim(),
    signRequests: f.signRequests,
    nameIdFormat: f.nameIdFormat,
    emailAttribute: nullable(f.emailAttribute),
    displayNameAttribute: nullable(f.displayNameAttribute),
    usernameAttribute: nullable(f.usernameAttribute),
    groupsAttribute: nullable(f.groupsAttribute),
    syncGroups: f.syncGroups,
    defaultGroups: splitList(f.defaultGroups),
    allowedDomains: splitDomains(f.allowedDomains),
    autoProvision: f.autoProvision,
    linkByEmail: f.linkByEmail,
    enforceSso: f.enforceSso,
    enabled: f.enabled,
  }
  if (f.signRequests) {
    if (f.spSigningKey.trim()) body.spSigningKey = f.spSigningKey.trim()
    if (f.spSigningCertificate.trim()) body.spSigningCertificate = f.spSigningCertificate.trim()
  }
  if (!f.id) body.slug = f.slug.trim()
  return body
}

/** First problem that would make the server refuse the form, or null. Server validation stays authoritative. */
export function samlProblem(f: SamlForm): string | null {
  if (!f.name.trim()) return 'Display name is required'
  if (!f.id && !/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(f.slug.trim())) return 'Slug: 3-40 lowercase letters, digits or dashes'
  if (!f.idpEntityId.trim()) return 'IdP entity ID is required'
  if (!/^https?:\/\/\S+$/.test(f.idpSsoUrl.trim())) return 'IdP SSO URL must be a URL'
  if (!/-----BEGIN CERTIFICATE-----/.test(f.idpCertificates)) return 'Paste the IdP signing certificate (PEM)'
  if (f.signRequests && !f.hasSigningKey && !(f.spSigningKey.trim() && f.spSigningCertificate.trim())) return 'Signing requests needs a private key and its certificate'
  return null
}

export function certificateStatus(c: { validTo: string; expired: boolean } | null | undefined, now = Date.now()): { tone: 'ok' | 'warn' | 'bad'; label: string } {
  if (!c) return { tone: 'bad', label: 'Not a certificate' }
  const days = Math.floor((new Date(c.validTo).getTime() - now) / 86_400_000)
  if (c.expired || days < 0) return { tone: 'bad', label: `Expired ${new Date(c.validTo).toISOString().slice(0, 10)}` }
  if (days <= 30) return { tone: 'warn', label: `Expires in ${days} day${days === 1 ? '' : 's'}` }
  return { tone: 'ok', label: `Valid until ${new Date(c.validTo).toISOString().slice(0, 10)}` }
}

export interface LdapForm {
  id?: number
  name: string
  url: string
  startTls: boolean
  tlsRejectUnauthorized: boolean
  bindDn: string
  bindPassword: string
  hasBindPassword: boolean
  baseDn: string
  userFilter: string
  usernameAttribute: string
  emailAttribute: string
  displayNameAttribute: string
  uniqueIdAttribute: string
  groupBaseDn: string
  groupFilter: string
  groupNameAttribute: string
  groupMemberAttribute: string
  nestedGroups: boolean
  loginEnabled: boolean
  autoProvision: boolean
  linkByEmail: boolean
  syncEnabled: boolean
  syncIntervalMinutes: number
  deactivateMissing: boolean
  maxEntries: number
  timeoutMs: number
  enabled: boolean
}

export const emptyLdapForm: LdapForm = {
  name: '', url: 'ldaps://', startTls: false, tlsRejectUnauthorized: true, bindDn: '', bindPassword: '', hasBindPassword: false, baseDn: '',
  userFilter: '(objectClass=person)', usernameAttribute: 'uid', emailAttribute: 'mail', displayNameAttribute: 'cn', uniqueIdAttribute: 'entryUUID',
  groupBaseDn: '', groupFilter: '(objectClass=groupOfNames)', groupNameAttribute: 'cn', groupMemberAttribute: 'member', nestedGroups: false,
  loginEnabled: true, autoProvision: false, linkByEmail: false, syncEnabled: false, syncIntervalMinutes: 360, deactivateMissing: true, maxEntries: 10000, timeoutMs: 10000, enabled: true,
}

/** Typical settings for Active Directory; applied on top of the current form. */
export function activeDirectoryPreset(f: LdapForm): LdapForm {
  return {
    ...f, userFilter: '(&(objectCategory=person)(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))',
    usernameAttribute: 'sAMAccountName', emailAttribute: 'mail', displayNameAttribute: 'displayName', uniqueIdAttribute: 'objectGUID',
    groupFilter: '(objectClass=group)', groupNameAttribute: 'cn', groupMemberAttribute: 'member', nestedGroups: true,
  }
}

export function ldapPayload(f: LdapForm): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: f.name.trim(), url: f.url.trim(), startTls: f.startTls, tlsRejectUnauthorized: f.tlsRejectUnauthorized,
    bindDn: f.bindDn.trim(), baseDn: f.baseDn.trim(), userFilter: f.userFilter.trim(),
    usernameAttribute: f.usernameAttribute.trim(), emailAttribute: f.emailAttribute.trim(), displayNameAttribute: f.displayNameAttribute.trim(), uniqueIdAttribute: f.uniqueIdAttribute.trim(),
    groupBaseDn: f.groupBaseDn.trim() || null, groupFilter: f.groupFilter.trim(), groupNameAttribute: f.groupNameAttribute.trim(), groupMemberAttribute: f.groupMemberAttribute.trim(),
    nestedGroups: f.nestedGroups, loginEnabled: f.loginEnabled, autoProvision: f.autoProvision, linkByEmail: f.linkByEmail,
    syncEnabled: f.syncEnabled, syncIntervalMinutes: Number(f.syncIntervalMinutes), deactivateMissing: f.deactivateMissing,
    maxEntries: Number(f.maxEntries), timeoutMs: Number(f.timeoutMs), enabled: f.enabled,
  }
  if (f.bindPassword) body.bindPassword = f.bindPassword
  return body
}

export function ldapProblem(f: LdapForm): string | null {
  if (!f.name.trim()) return 'Name is required'
  if (!/^ldaps?:\/\/[^/\s@]+$/i.test(f.url.trim())) return 'URL must look like ldaps://host:636'
  if (/^ldaps:/i.test(f.url.trim()) && f.startTls) return 'StartTLS cannot be combined with ldaps://'
  if (!f.bindDn.trim() || !f.baseDn.trim()) return 'Bind DN and base DN are required'
  if (!f.id && !f.bindPassword) return 'Bind password is required'
  for (const [label, v] of [['User filter', f.userFilter], ['Group filter', f.groupFilter]] as const) {
    if (!/^\(.*\)$/.test(v.trim())) return `${label} must be wrapped in parentheses`
  }
  if (!(f.syncIntervalMinutes >= 5 && f.syncIntervalMinutes <= 10080)) return 'Sync interval must be between 5 and 10080 minutes'
  return null
}

export interface SyncCounts {
  directoryUsers: number; create: number; link: number; update: number; reactivate: number; deactivate: number; skipped: number
  groupsCreate: number; membershipsAdd: number; membershipsRemove: number
}

/** One line per non-zero figure, in the order an administrator cares about. */
export function syncSummary(c: SyncCounts, applied = false): string[] {
  const rows: Array<[number, string]> = [
    [c.create, applied ? 'users created' : 'users to create'], [c.link, applied ? 'existing accounts linked' : 'existing accounts to link'],
    [c.update, applied ? 'users updated' : 'users to update'], [c.reactivate, applied ? 'users reactivated' : 'users to reactivate'],
    [c.deactivate, applied ? 'users deactivated' : 'users to deactivate'], [c.skipped, 'users skipped'], [c.groupsCreate, applied ? 'groups created' : 'groups to create'],
    [c.membershipsAdd, applied ? 'memberships added' : 'memberships to add'], [c.membershipsRemove, applied ? 'memberships removed' : 'memberships to remove'],
  ]
  const out = rows.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`)
  return out.length ? out : ['Nothing to change']
}

const SKIP_REASONS: Record<string, string> = {
  no_email: 'no email address', duplicate_email: 'email shared with another directory user', email_in_use: 'email belongs to another account',
  deactivated_manually: 'deactivated by an administrator', not_provisioned: 'creating users is switched off', seat_limit: 'seat limit reached',
}
export const skipReason = (code: string): string => SKIP_REASONS[code] ?? code

const SSO_ERRORS: Record<string, string> = {
  invalid_state: 'Your sign-in session expired. Please try again.',
  token_invalid: 'The identity provider response could not be verified.',
  domain_not_allowed: 'Your email domain is not allowed to sign in here.',
  not_provisioned: 'No account exists for you. Ask an administrator for access.',
  account_exists: 'An account with this email already exists. Sign in with your password or ask an administrator to link it.',
  account_disabled: 'This account is deactivated.',
  email_missing: 'The identity provider did not share an email address.',
  email_unverified: 'The identity provider has not verified your email address.',
  idp_error: 'The identity provider reported an error.',
  sso_unavailable: 'Single sign-on is currently unavailable.',
  licence_required: 'Creating accounts through single sign-on needs a licence that includes it.',
  seat_limit: 'The licence seat limit is reached. Ask an administrator.',
  rate_limited: 'Too many sign-in attempts. Wait a minute and try again.',
  nameid_transient: 'The identity provider sent a one-time identifier. Ask your administrator to configure a persistent or email NameID.',
  saml_signature: 'The sign-in response was not signed by the trusted identity provider.',
  saml_audience: 'The sign-in response was meant for a different application.',
  saml_recipient: 'The sign-in response was addressed to a different address.',
  saml_destination: 'The sign-in response was addressed to a different address.',
  saml_assertion_expired: 'The sign-in response has expired. Check the clocks of the identity provider and this server, then try again.',
  saml_in_response_to: 'The sign-in response does not belong to this sign-in attempt. Please start again.',
  saml_replayed: 'This sign-in response was already used. Please start again.',
  saml_issuer: 'The sign-in response came from an unexpected identity provider.',
  saml_idp_error: 'The identity provider refused the sign-in.',
}

/** Message for ?sso_error=<code> on the sign-in page. Unknown SAML codes stay generic and never echo the input. */
export function ssoErrorMessage(code: string): string {
  return SSO_ERRORS[code] ?? (code.startsWith('saml_') ? 'The SAML sign-in response was not accepted.' : 'Single sign-on failed')
}
