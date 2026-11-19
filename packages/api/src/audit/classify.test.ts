import { describe, it, expect } from 'bun:test'
import { classifyRequest, csvCell, toCsv } from './classify'

const q = (m: Record<string, string>) => (n: string) => m[n]

describe('classifyRequest', () => {
  it('ignores reads and non-admin routes', () => {
    expect(classifyRequest('GET', '/rest/api/2/user')).toBeNull()
    expect(classifyRequest('POST', '/rest/api/2/issue')).toBeNull()
    expect(classifyRequest('PUT', '/rest/api/2/project/ABC')).toBeNull()
    expect(classifyRequest('POST', '/rest/servicedeskapi/portal/it/request')).toBeNull()
    expect(classifyRequest('POST', '/rest/servicedeskapi/inbound-email/it')).toBeNull()
  })

  it('classifies users and groups with query/path targets', () => {
    expect(classifyRequest('POST', '/rest/api/2/user')).toEqual({ action: 'USER_CREATED', targetType: 'user', target: null })
    expect(classifyRequest('DELETE', '/rest/api/2/user', q({ username: 'bob' }))).toEqual({ action: 'USER_DELETED', targetType: 'user', target: 'bob' })
    expect(classifyRequest('PUT', '/rest/api/2/user/', q({ username: 'bob' }))?.action).toBe('USER_UPDATED')
    expect(classifyRequest('DELETE', '/rest/api/2/group', q({ groupname: 'devs' }))).toEqual({ action: 'GROUP_DELETED', targetType: 'group', target: 'devs' })
    expect(classifyRequest('POST', '/rest/api/2/group/member')?.action).toBe('GROUP_MEMBER_ADDED')
    expect(classifyRequest('DELETE', '/rest/api/2/group/user')?.action).toBe('GROUP_MEMBER_REMOVED')
  })

  it('classifies schemes, config and tokens', () => {
    expect(classifyRequest('POST', '/rest/api/2/permissionscheme/7/assign')).toEqual({ action: 'PERMISSION_SCHEME_ASSIGNED', targetType: 'permission_scheme', target: '7' })
    expect(classifyRequest('PUT', '/rest/api/2/permissionscheme/7')?.action).toBe('PERMISSION_SCHEME_UPDATED')
    expect(classifyRequest('PUT', '/rest/api/2/admin/workflowscheme/3')).toEqual({ action: 'WORKFLOW_SCHEME_UPDATED', targetType: 'workflow_scheme', target: '3' })
    expect(classifyRequest('PUT', '/rest/api/2/admin/system/mail')?.action).toBe('MAIL_CONFIG_UPDATED')
    expect(classifyRequest('PUT', '/rest/api/2/admin/system/config')?.action).toBe('GENERAL_CONFIG_UPDATED')
    expect(classifyRequest('POST', '/rest/auth/1/sso/settings')?.action).toBe('SSO_CONFIG_UPDATED')
    expect(classifyRequest('POST', '/rest/api/2/mypersonalaccessTokens')).toMatchObject({ action: 'API_TOKEN_CREATED', targetType: 'api_token' })
    expect(classifyRequest('DELETE', '/rest/api/2/mypersonalaccessTokens/12')).toMatchObject({ action: 'API_TOKEN_DELETED', target: '12' })
    expect(classifyRequest('DELETE', '/rest/api/2/project/ABC')).toEqual({ action: 'PROJECT_DELETED', targetType: 'project', target: 'ABC' })
    expect(classifyRequest('POST', '/rest/agile/1.0/sprint/7/start')).toEqual({ action: 'SPRINT_STARTED', targetType: 'sprint', target: '7' })
    expect(classifyRequest('POST', '/rest/agile/1.0/sprint/7/complete')).toEqual({ action: 'SPRINT_COMPLETED', targetType: 'sprint', target: '7' })
    expect(classifyRequest('DELETE', '/rest/agile/1.0/sprint/7')).toEqual({ action: 'SPRINT_DELETED', targetType: 'sprint', target: '7' })
    expect(classifyRequest('PUT', '/rest/agile/1.0/sprint/7')).toBeNull()
    expect(classifyRequest('POST', '/rest/agile/1.0/sprint/7/issue')).toBeNull()
  })

  it('records workflow designer, transition and status changes', () => {
    expect(classifyRequest('POST', '/rest/api/2/admin/workflow')).toEqual({ action: 'WORKFLOW_CREATED', targetType: 'workflow', target: null })
    expect(classifyRequest('PUT', '/rest/api/2/admin/workflow/4')).toEqual({ action: 'WORKFLOW_UPDATED', targetType: 'workflow', target: '4' })
    expect(classifyRequest('DELETE', '/rest/api/2/admin/workflow/4')?.action).toBe('WORKFLOW_DELETED')
    expect(classifyRequest('POST', '/rest/api/2/admin/workflow/4/transition')).toEqual({ action: 'WORKFLOW_TRANSITION_CREATED', targetType: 'workflow', target: '4' })
    expect(classifyRequest('PUT', '/rest/api/2/admin/workflow/4/transition/9')?.action).toBe('WORKFLOW_TRANSITION_UPDATED')
    expect(classifyRequest('DELETE', '/rest/api/2/admin/workflow/4/transition/9')?.action).toBe('WORKFLOW_TRANSITION_DELETED')
    expect(classifyRequest('PUT', '/rest/api/2/admin/workflow/4/layout')?.action).toBe('WORKFLOW_LAYOUT_UPDATED')
    expect(classifyRequest('POST', '/rest/api/2/admin/status')).toEqual({ action: 'STATUS_CREATED', targetType: 'status', target: null })
    expect(classifyRequest('DELETE', '/rest/api/2/admin/status/12')).toEqual({ action: 'STATUS_DELETED', targetType: 'status', target: '12' })
    expect(classifyRequest('GET', '/rest/api/2/admin/workflow/4')).toBeNull()
    expect(classifyRequest('PUT', '/rest/api/2/admin/workflowscheme/3')?.targetType).toBe('workflow_scheme')
  })

  it('names sub-resources of nested admin routes', () => {
    expect(classifyRequest('POST', '/rest/api/2/admin/screen/4/tab/2/field')).toMatchObject({ action: 'SCREEN_TAB_CREATED', target: '4' })
    expect(classifyRequest('DELETE', '/rest/api/2/admin/customfield/9/option/3')?.action).toBe('CUSTOM_FIELD_OPTION_DELETED')
    expect(classifyRequest('POST', '/rest/servicedeskapi/servicedesk/2/sla')).toEqual({ action: 'SERVICE_DESK_SLA_CREATED', targetType: 'service_desk', target: '2' })
    expect(classifyRequest('POST', '/rest/servicedeskapi/servicedesk/2/calendar')?.action).toBe('SERVICE_DESK_CALENDAR_CREATED')
    expect(classifyRequest('PUT', '/rest/servicedeskapi/servicedesk/2/calendar/5')?.action).toBe('SERVICE_DESK_CALENDAR_UPDATED')
    expect(classifyRequest('POST', '/rest/servicedeskapi/servicedesk/2/calendar/5/holiday')?.action).toBe('SERVICE_DESK_CALENDAR_CREATED')
    expect(classifyRequest('DELETE', '/rest/servicedeskapi/servicedesk/2/sla/9')?.action).toBe('SERVICE_DESK_SLA_DELETED')
    // the calendar preview is a read-only calculator, not an admin change
    expect(classifyRequest('POST', '/rest/servicedeskapi/servicedesk/2/calendar/preview')).toBeNull()
    expect(classifyRequest('PUT', '/rest/servicedeskapi/servicedesk/2/email-channel')?.action).toBe('SERVICE_DESK_EMAIL_CHANNEL_UPDATED')
    expect(classifyRequest('PUT', '/rest/servicedeskapi/servicedesk/2')?.action).toBe('SERVICE_DESK_UPDATED')
  })

  it('classifies service desk form builder and portal configuration routes', () => {
    expect(classifyRequest('POST', '/rest/servicedeskapi/servicedesk')?.action).toBe('SERVICE_DESK_CREATED')
    expect(classifyRequest('POST', '/rest/servicedeskapi/servicedesk/2/requesttype')).toEqual({ action: 'REQUEST_TYPE_CREATED', targetType: 'request_type', target: null })
    expect(classifyRequest('PUT', '/rest/servicedeskapi/servicedesk/2/requesttype/9')).toEqual({ action: 'REQUEST_TYPE_UPDATED', targetType: 'request_type', target: '9' })
    expect(classifyRequest('DELETE', '/rest/servicedeskapi/servicedesk/2/requesttype/9')?.action).toBe('REQUEST_TYPE_DELETED')
    expect(classifyRequest('POST', '/rest/servicedeskapi/servicedesk/2/requesttype/9/duplicate')).toEqual({ action: 'REQUEST_TYPE_DUPLICATED', targetType: 'request_type', target: '9' })
    expect(classifyRequest('POST', '/rest/servicedeskapi/servicedesk/2/requesttype/reorder')?.action).toBe('REQUEST_TYPE_REORDERED')
    expect(classifyRequest('PUT', '/rest/servicedeskapi/servicedesk/2/portal-settings')?.action).toBe('SERVICE_DESK_PORTAL_UPDATED')
    expect(classifyRequest('POST', '/rest/servicedeskapi/servicedesk/2/organization')?.action).toBe('SERVICE_DESK_ORGANIZATION_CREATED')
    expect(classifyRequest('DELETE', '/rest/servicedeskapi/servicedesk/2/customer/5')?.action).toBe('SERVICE_DESK_CUSTOMER_DELETED')
  })
})

describe('csv', () => {
  it('quotes separators, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('l1\nl2')).toBe('"l1\nl2"')
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
  })

  it('neutralises formula injection', () => {
    for (const bad of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', '\rx']) {
      expect(csvCell(bad).replace(/^"/, '').startsWith("'")).toBe(true)
    }
    expect(csvCell("=HYPERLINK(\"http://x\",\"y\")")).toBe('"\'=HYPERLINK(""http://x"",""y"")"')
    expect(csvCell('safe=value')).toBe('safe=value')
  })

  it('keeps numbers and dates, stringifies objects safely', () => {
    expect(csvCell(-5)).toBe('-5')
    expect(csvCell(new Date('2026-01-02T03:04:05Z'))).toBe('2026-01-02T03:04:05.000Z')
    expect(csvCell({ fields: ['a'] })).toBe('"{""fields"":[""a""]}"')
  })

  it('classifies branding changes', () => {
    expect(classifyRequest('PUT', '/rest/api/2/admin/branding')).toEqual({ action: 'BRANDING_UPDATED', targetType: 'branding', target: null })
    expect(classifyRequest('DELETE', '/rest/api/2/admin/branding')?.action).toBe('BRANDING_DELETED')
    expect(classifyRequest('POST', '/rest/api/2/admin/branding/logo/dark')).toEqual({ action: 'BRANDING_FILE_CREATED', targetType: 'branding', target: 'dark' })
    expect(classifyRequest('GET', '/rest/api/2/branding')).toBeNull()
  })

  it('builds CRLF-terminated rows with a header', () => {
    expect(toCsv(['a', 'b'], [[1, '=x'], ['y', null]])).toBe("a,b\r\n1,'=x\r\ny,\r\n")
  })
})
