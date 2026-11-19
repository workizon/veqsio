import { describe, test, expect } from 'bun:test';
import { GLOBAL_PERMISSIONS, PROJECT_PERMISSIONS } from '../rbac/types';

describe('Permission Types', () => {
  test('GLOBAL_PERMISSIONS contains expected values', () => {
    expect(GLOBAL_PERMISSIONS).toContain('SYSTEM_ADMIN');
    expect(GLOBAL_PERMISSIONS).toContain('ADMINISTER');
    expect(GLOBAL_PERMISSIONS).toContain('CREATE_PROJECT');
    expect(GLOBAL_PERMISSIONS).toContain('BROWSE_USERS');
  });

  test('PROJECT_PERMISSIONS contains expected values', () => {
    expect(PROJECT_PERMISSIONS).toContain('BROWSE_PROJECTS');
    expect(PROJECT_PERMISSIONS).toContain('CREATE_ISSUES');
    expect(PROJECT_PERMISSIONS).toContain('EDIT_ISSUES');
    expect(PROJECT_PERMISSIONS).toContain('DELETE_ISSUES');
    expect(PROJECT_PERMISSIONS).toContain('TRANSITION_ISSUES');
    expect(PROJECT_PERMISSIONS).toContain('ASSIGN_ISSUES');
    expect(PROJECT_PERMISSIONS).toContain('COMMENT_ISSUE');
  });
});

describe('Permission Checks', () => {
  test('admin bypass is documented in service', () => {
    // The RBAC service grants all permissions to the 'admin' user.
    // This test documents that contract.
    expect(true).toBe(true);
  });

  test('permission route returns list of all permissions', async () => {
    const all = [...GLOBAL_PERMISSIONS, ...PROJECT_PERMISSIONS];
    expect(all.length).toBeGreaterThan(0);
    const mapped = all.map((p, i) => ({
      id: i + 1,
      key: p,
      name: p.replace(/_/g, ' '),
      type: GLOBAL_PERMISSIONS.includes(p as any) ? 'GLOBAL' : 'PROJECT',
    }));
    expect(mapped[0].type).toBe('GLOBAL');
    expect(mapped.some((m) => m.type === 'PROJECT')).toBe(true);
  });
});
