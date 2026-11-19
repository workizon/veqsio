import { describe, test, expect } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { issueVisibleSql, redactIssueResponses, LEVEL_MEMBER_TYPES } from './issue-security';
import { targetsOfPath } from './guard';

const dialect = new PgDialect();
const render = (q: any) => dialect.sqlToQuery(q);

describe('issueVisibleSql', () => {
  test('anonymous: only issues without a level', () => {
    const { sql, params } = render(issueVisibleSql(null));
    expect(sql).toBe('(issues.security_level_id IS NULL)');
    expect(params).toEqual([]);
  });
  test('a user: no level, or a member row of the level that matches one of every member type', () => {
    const { sql, params } = render(issueVisibleSql(42));
    expect(sql).toContain('issues.security_level_id IS NULL OR EXISTS');
    for (const t of LEVEL_MEMBER_TYPES) expect(sql).toContain(`'${t}'`);
    expect(sql).toContain('issues.reporter_id = $');
    expect(sql).toContain('issues.assignee_id = $');
    expect(sql).toContain('lp.lead_id = $');
    expect(params.every((p) => p === 42)).toBe(true);
    expect(params.length).toBeGreaterThan(6);
  });
  test('the table alias is configurable and validated (no SQL injection through it)', () => {
    expect(render(issueVisibleSql(1, 'i')).sql).toContain('i.security_level_id');
    expect(() => issueVisibleSql(1, 'i; drop table x')).toThrow();
  });
});

describe('guard path targets', () => {
  test('issue references in REST, agile, service desk and module paths', () => {
    expect(targetsOfPath('/rest/api/2/issue/TEST-1')).toEqual([{ kind: 'issue', ref: 'TEST-1' }]);
    expect(targetsOfPath('/rest/api/2/issue/TEST-1/comment/5')).toEqual([{ kind: 'issue', ref: 'TEST-1' }]);
    expect(targetsOfPath('/rest/agile/1.0/roadmap/issue/TEST-9/dates')).toEqual([{ kind: 'issue', ref: 'TEST-9' }]);
    expect(targetsOfPath('/rest/servicedeskapi/portal/acme/request/DESK-3/comment')).toEqual([{ kind: 'issue', ref: 'DESK-3' }]);
    expect(targetsOfPath('/rest/modules/itsm/issues/INC-1/kind')).toEqual([{ kind: 'issue', ref: 'INC-1' }]);
    expect(targetsOfPath('/rest/public/issues/TEST-1')).toEqual([{ kind: 'issue', ref: 'TEST-1' }]);
  });
  test('reserved words and unrelated paths name no issue', () => {
    for (const p of ['/rest/api/2/issue/createmeta', '/rest/api/2/issue/bulk', '/rest/api/2/issue/similar', '/rest/api/2/issue/ai/suggest', '/rest/api/2/search', '/rest/servicedeskapi/servicedesk/1/requesttype/3']) {
      expect(targetsOfPath(p)).toEqual([]);
    }
  });
  test('attachments, worklogs, links and approvals are resolved through their issue', () => {
    expect(targetsOfPath('/rest/api/2/attachment/12')).toEqual([{ kind: 'attachment', id: 12 }]);
    expect(targetsOfPath('/rest/api/2/worklog/3')).toEqual([{ kind: 'worklog', id: 3 }]);
    expect(targetsOfPath('/rest/api/2/issueLink/8')).toEqual([{ kind: 'link', id: 8 }]);
    expect(targetsOfPath('/rest/api/2/approval/4')).toEqual([{ kind: 'approval', id: 4 }]);
    expect(targetsOfPath('/rest/api/2/attachment/abc')).toEqual([]);
  });
  test('encoded keys are decoded', () => {
    expect(targetsOfPath('/rest/api/2/issue/TEST%2D1')).toEqual([{ kind: 'issue', ref: 'TEST-1' }]);
  });
});

describe('redactIssueResponses', () => {
  test('without nested references nothing is queried and the input is returned as is', async () => {
    const input = [{ id: 1, fields: { parent: null, subtasks: [], issuelinks: [] } }];
    expect(await redactIssueResponses(1, input)).toBe(input);
  });
});
