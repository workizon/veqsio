import { describe, expect, test } from 'bun:test';
import { isBlockedInDemo } from './demo-mode';

const q = (s = '') => new URLSearchParams(s);

describe('demo mode', () => {
  test('ordinary reads are never blocked, bulk exports are', () => {
    expect(isBlockedInDemo('GET', '/rest/api/2/admin/system/mail', q())).toBe(false);
    expect(isBlockedInDemo('GET', '/rest/api/2/webhook', q())).toBe(false);
    expect(isBlockedInDemo('GET', '/rest/api/2/admin/system/backup', q())).toBe(true);
    expect(isBlockedInDemo('GET', '/rest/api/2/admin/config/export', q())).toBe(true);
    expect(isBlockedInDemo('GET', '/rest/api/2/admin/audit/export', q())).toBe(true);
  });
  test('outgoing and system functions are blocked for writes', () => {
    for (const [m, p] of [
      ['PUT', '/rest/api/2/admin/system/mail'], ['POST', '/rest/api/2/admin/system/mail/test'], ['POST', '/rest/api/2/webhook'],
      ['POST', '/rest/api/2/webhook/3/test'], ['POST', '/rest/api/2/migration/tools/linear/run'], ['PUT', '/rest/api/2/admin/ai'],
      ['POST', '/rest/api/2/admin/ldap'], ['POST', '/rest/api/2/admin/plugins'], ['POST', '/rest/api/2/admin/system/backup'],
      ['POST', '/rest/auth/1/password-reset/request'], ['PUT', '/rest/servicedeskapi/servicedesk/2/email-channel'],
      ['POST', '/rest/api/2/project/OPS/repositories'], ['DELETE', '/rest/api/2/admin/license'],
    ] as const) expect(isBlockedInDemo(m, p, q())).toBe(true);
  });
  test('ordinary work is allowed', () => {
    for (const [m, p] of [['POST', '/rest/api/2/issue'], ['PUT', '/rest/api/2/issue/DEMO-1'], ['POST', '/rest/api/2/issue/DEMO-1/comment'], ['POST', '/rest/api/2/project'], ['POST', '/rest/api/2/csv-import/preview']] as const) {
      expect(isBlockedInDemo(m, p, q())).toBe(false);
    }
  });
  test('the administrator account is protected', () => {
    expect(isBlockedInDemo('PUT', '/rest/api/2/user', q('username=admin'), { password: 'x' })).toBe(true);
    expect(isBlockedInDemo('PUT', '/rest/api/2/user', q('username=admin'), { active: false })).toBe(true);
    expect(isBlockedInDemo('DELETE', '/rest/api/2/user', q('username=admin'))).toBe(true);
    expect(isBlockedInDemo('DELETE', '/rest/api/2/group/user', q('groupname=veqsio-users&username=admin'))).toBe(true);
    expect(isBlockedInDemo('PUT', '/rest/api/2/user', q('username=anna'), { displayName: 'Anna P.' })).toBe(false);
  });
});
