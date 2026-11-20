import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { redis } from '../../src/services/cache';
import { checkSlaBreaches, checkSla } from '../../src/servicedesk/breach';

describe('Service Desk SLA calendars and metrics', () => {
  let seeded: any;
  let testSql: ReturnType<typeof createTestSql>;
  let admin: string, agent: string, alice: string, outsider: string;
  let deskId: number;
  let rtId: number;
  let waitingId: number;
  let calId: number;
  let alwaysId: number;
  let sampleId: number;
  const D = () => `/rest/servicedeskapi/servicedesk/${deskId}`;

  const call = (cookie: string, method: string, url: string, body?: unknown) =>
    app.request(url, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const login = async (username: string) => {
    const res = await app.request('/rest/auth/1/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'pw-123456' }),
    });
    return res.headers.get('set-cookie') || '';
  };
  const resetLimits = async () => { for (let uid = 1; uid <= 30; uid++) await redis.del(`veqsio:ratelimit:user:${uid}`); };

  /** Creates a request as alice via the portal and back-dates it. */
  async function newRequest(summary: string, createdMinutesAgo: number): Promise<{ key: string; id: number }> {
    await resetLimits();
    const res = await call(alice, 'POST', '/rest/servicedeskapi/portal/sla-desk/request', { requestTypeId: rtId, summary });
    expect(res.status).toBe(201);
    const key = (await res.json()).key;
    const db = createTestDb(testSql);
    const [row] = await db.update(schema.issues).set({ createdAt: new Date(Date.now() - createdMinutesAgo * 60_000) })
      .where(eq(schema.issues.issueKey, key)).returning();
    return { key, id: row.id };
  }
  const slaFor = async (key: string) => {
    const res = await call(admin, 'GET', `${D()}/request`);
    return (await res.json()).values.find((r: any) => r.key === key).sla as any[];
  };

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    const [, ag] = await db.insert(schema.users).values([
      { username: 'alice', email: 'alice@example.com', displayName: 'Alice', passwordHash: hash },
      { username: 'agentx', email: 'agentx@example.com', displayName: 'Agent X', passwordHash: hash },
      { username: 'outsider', email: 'outsider@example.com', displayName: 'Out', passwordHash: hash },
    ]).returning();
    const [waiting] = await db.insert(schema.statuses).values({ name: 'Waiting for customer', category: 'in_progress' }).returning();
    waitingId = waiting.id;
    admin = await login('admin');
    alice = await login('alice');
    agent = await login('agentx');
    outsider = await login('outsider');

    let res = await call(admin, 'POST', '/rest/servicedeskapi/servicedesk', { projectKey: 'TEST', name: 'SLA Desk', slug: 'sla-desk', publicSignup: true });
    deskId = (await res.json()).id;
    res = await call(admin, 'POST', `${D()}/agent`, { userId: ag.id, role: 'agent' });
    expect(res.status).toBeLessThan(300);
    res = await call(admin, 'POST', `${D()}/requesttype`, { name: 'Help', issueTypeId: seeded.issueType.id, defaultPriorityId: seeded.priority.id });
    rtId = (await res.json()).id;
  });

  afterAll(async () => {
    await resetTestDb(testSql);
    await testSql.end();
  });

  describe('calendars', () => {
    test('built-in 24/7 and Sample 9-5 calendars exist for every desk', async () => {
      const res = await call(admin, 'GET', `${D()}/calendar`);
      expect(res.status).toBe(200);
      const values = (await res.json()).values;
      expect(values.map((c: any) => c.name)).toEqual(['24/7', 'Sample 9-5 Calendar']);
      alwaysId = values[0].id; sampleId = values[1].id;
      expect(values[0].builtIn).toBe(true);
      expect(values[1].workingHours.mon).toEqual([['09:00', '17:00']]);
      expect(values[1].workingHours.sat).toBeUndefined();
      // idempotent
      expect((await (await call(admin, 'GET', `${D()}/calendar`)).json()).values).toHaveLength(2);
    });

    test('admin creates a calendar with multi-interval days and holidays', async () => {
      const res = await call(admin, 'POST', `${D()}/calendar`, {
        name: 'Berlin support', timeZone: 'Europe/Berlin',
        workingHours: { mon: [['08:00', '12:00'], ['13:00', '17:00']], tue: [['08:00', '17:00']], sat: [] },
        holidays: [{ date: '2026-12-25', name: 'Christmas', recurring: true }, { date: '2026-11-11', name: 'Day off' }],
      });
      expect(res.status).toBe(201);
      const cal = await res.json();
      calId = cal.id;
      expect(cal.holidays.map((h: any) => h.date)).toEqual(['2026-11-11', '2026-12-25']);
      expect(cal.holidays[1].recurring).toBe(true);
    });

    test('validation errors use the errorMessages shape', async () => {
      const cases: Array<[any, number]> = [
        [{ name: 'x', timeZone: 'Mars/Base' }, 400],
        [{ name: 'x', workingHours: { mon: [['17:00', '09:00']] } }, 400],
        [{ name: 'x', workingHours: { mon: [['09:00', '12:00'], ['11:00', '13:00']] } }, 400],
        [{ name: 'x', workingHours: { monday: [] } }, 400],
        [{ name: '' }, 400],
        [{ name: 'x', holidays: [{ date: '2026-02-30', name: 'bad' }] }, 400],
        [{ name: 'Berlin support' }, 409],
      ];
      for (const [body, status] of cases) {
        const res = await call(admin, 'POST', `${D()}/calendar`, body);
        expect(res.status).toBe(status);
        const j = await res.json();
        expect(Array.isArray(j.errorMessages)).toBe(true);
        expect(j.errorMessages.length).toBeGreaterThan(0);
      }
    });

    test('update replaces holidays; single holiday add and delete', async () => {
      let res = await call(admin, 'PUT', `${D()}/calendar/${calId}`, {
        name: 'Berlin support', timeZone: 'Europe/Berlin', workingHours: { mon: [['08:00', '17:00']] },
        holidays: [{ date: '2026-11-11', name: 'Day off' }],
      });
      expect(res.status).toBe(200);
      expect((await res.json()).holidays).toHaveLength(1);

      res = await call(admin, 'POST', `${D()}/calendar/${calId}/holiday`, { date: '2026-12-24', name: 'Xmas eve', recurring: true });
      expect(res.status).toBe(201);
      const hid = (await res.json()).id;
      let got = await (await call(admin, 'GET', `${D()}/calendar/${calId}`)).json();
      expect(got.holidays).toHaveLength(2);

      res = await call(admin, 'DELETE', `${D()}/calendar/${calId}/holiday/${hid}`);
      expect(res.status).toBe(204);
      got = await (await call(admin, 'GET', `${D()}/calendar/${calId}`)).json();
      expect(got.holidays).toHaveLength(1);
      expect((await call(admin, 'DELETE', `${D()}/calendar/${calId}/holiday/${hid}`)).status).toBe(404);
      // omitting holidays keeps them
      res = await call(admin, 'PUT', `${D()}/calendar/${calId}`, { name: 'Berlin support', timeZone: 'Europe/Berlin', workingHours: { mon: [['08:00', '17:00']] } });
      expect((await res.json()).holidays).toHaveLength(1);
    });

    test('built-in 24/7 is read-only', async () => {
      expect((await call(admin, 'PUT', `${D()}/calendar/${alwaysId}`, { name: 'x' })).status).toBe(409);
      expect((await call(admin, 'DELETE', `${D()}/calendar/${alwaysId}`)).status).toBe(409);
    });

    test('preview computes the due time across weekends and holidays', async () => {
      // Sample 9-5 UTC: Mon 16:00 + 2h -> Tue 10:00
      let res = await call(admin, 'POST', `${D()}/calendar/preview`, { calendarId: sampleId, start: '2026-11-09T16:00:00Z', durationMinutes: 120 });
      expect(res.status).toBe(200);
      let j = await res.json();
      expect(j.due).toBe('2026-11-10T10:00:00.000Z');
      expect(j.workingMinutes).toBe(120);
      // Friday evening + 2h -> Monday 10:00
      res = await call(admin, 'POST', `${D()}/calendar/preview`, { calendarId: sampleId, start: '2026-11-13T16:00:00Z', durationMinutes: 120 });
      expect((await res.json()).due).toBe('2026-11-16T10:00:00.000Z');
      // 24/7 ignores hours
      res = await call(admin, 'POST', `${D()}/calendar/preview`, { calendarId: alwaysId, start: '2026-11-13T16:00:00Z', durationMinutes: 120 });
      expect((await res.json()).due).toBe('2026-11-13T18:00:00.000Z');
      // Berlin calendar (UTC+1): Mon 08-17 local; holiday on Wed 11 Nov. Tue has no hours now -> Mon 15:00Z (16:00 local) + 2h = Mon 16:00Z (17:00) is 1h, next working day Mon 16th
      res = await call(admin, 'POST', `${D()}/calendar/preview`, { calendarId: calId, start: '2026-11-09T15:00:00Z', durationMinutes: 120 });
      j = await res.json();
      expect(j.due).toBe('2026-11-16T08:00:00.000Z'); // 1h Mon 9th + 1h Mon 16th starting 08:00 local = 07:00Z -> 08:00Z
      // unsaved calendar from the editor
      res = await call(admin, 'POST', `${D()}/calendar/preview`, {
        calendar: { timeZone: 'America/New_York', workingHours: { mon: [['09:00', '17:00']] }, holidays: [] },
        start: '2026-11-09T12:00:00Z', durationMinutes: 60,
      });
      expect((await res.json()).due).toBe('2026-11-09T15:00:00.000Z'); // 09:00 EST = 14:00Z, +1h
      // empty calendar
      res = await call(admin, 'POST', `${D()}/calendar/preview`, { calendar: { timeZone: 'UTC', workingHours: {} }, start: '2026-11-09T12:00:00Z', durationMinutes: 60 });
      expect((await res.json()).due).toBeNull();
      // bad input
      expect((await call(admin, 'POST', `${D()}/calendar/preview`, { start: '2026-11-09T12:00:00Z', durationMinutes: 60 })).status).toBe(400);
      expect((await call(admin, 'POST', `${D()}/calendar/preview`, { calendarId: 99999, start: '2026-11-09T12:00:00Z', durationMinutes: 60 })).status).toBe(404);
    });

    test('access control: admin only, no desk enumeration', async () => {
      expect((await call(agent, 'GET', `${D()}/calendar`)).status).toBe(403);
      expect((await call(agent, 'POST', `${D()}/calendar`, { name: 'nope' })).status).toBe(403);
      expect((await call(agent, 'POST', `${D()}/calendar/preview`, { calendarId: sampleId, start: '2026-11-09T12:00:00Z', durationMinutes: 1 })).status).toBe(403);
      expect((await call(outsider, 'GET', `${D()}/calendar`)).status).toBe(404);
      expect((await call(alice, 'GET', `${D()}/calendar`)).status).toBe(404);
      expect((await app.request(`${D()}/calendar`)).status).toBe(401);
    });

    test('calendars are scoped to their desk', async () => {
      const db = createTestDb(testSql);
      const [proj] = await db.insert(schema.projects).values({ projectKey: 'OTH', name: 'Other', leadId: seeded.user.id }).returning();
      const res = await call(admin, 'POST', '/rest/servicedeskapi/servicedesk', { projectKey: 'OTH', name: 'Other desk', slug: 'other-sla' });
      const other = (await res.json()).id;
      expect(proj.id).toBeGreaterThan(0);
      expect((await call(admin, 'GET', `/rest/servicedeskapi/servicedesk/${other}/calendar/${calId}`)).status).toBe(404);
      const slaRes = await call(admin, 'POST', `/rest/servicedeskapi/servicedesk/${other}/sla`, { name: 'x', calendarId: calId, goals: [{ targetMinutes: 5 }] });
      expect(slaRes.status).toBe(400);
    });
  });

  describe('SLA metrics', () => {
    let frtId: number;

    test('admin creates a Jira-style metric with conditions, goals and warning', async () => {
      const res = await call(admin, 'POST', `${D()}/sla`, {
        name: 'Time to first response', metric: 'first_response', calendarId: alwaysId, warningPercent: 80,
        startConditions: [{ event: 'issue_created' }],
        pauseConditions: [{ event: 'status_entered', statusIds: [waitingId] }],
        stopConditions: [{ event: 'comment_agent' }],
        goals: [
          { criteria: { priorityIds: [seeded.priority.id] }, targetMinutes: 30 },
          { criteria: {}, targetMinutes: 240 },
        ],
      });
      expect(res.status).toBe(201);
      const sla = await res.json();
      frtId = sla.id;
      expect(sla.goals.map((g: any) => g.targetMinutes)).toEqual([30, 240]);
      expect(sla.goals[0].criteria).toEqual({ priorityIds: [seeded.priority.id] });
      expect(sla.warningPercent).toBe(80);
      expect(sla.usesLegacyConditions).toBe(false);
    });

    test('validation: unknown status, invalid JQL, restart outside start, status events need statuses, bad calendar', async () => {
      const ok = { name: 'v', goals: [{ targetMinutes: 5 }] };
      const bad: any[] = [
        { ...ok, pauseConditions: [{ event: 'status_entered', statusIds: [987654] }] },
        { ...ok, startConditions: [{ event: 'status_entered' }] },
        { ...ok, stopConditions: [{ event: 'comment_agent', restart: true }] },
        { ...ok, startConditions: [{ event: 'nonsense' }] },
        { ...ok, goals: [{ targetMinutes: 5, jql: 'priority = = =' }] },
        { ...ok, goals: [{ targetMinutes: 0 }] },
        { ...ok, goals: [] },
        { ...ok, warningPercent: 100 },
        { ...ok, calendarId: 424242 },
        { ...ok, extra: true },
      ];
      for (const body of bad) {
        const res = await call(admin, 'POST', `${D()}/sla`, body);
        expect(res.status).toBe(400);
        expect((await res.json()).errorMessages.length).toBeGreaterThan(0);
      }
    });

    test('PUT replaces all goals and conditions; goal order is preserved', async () => {
      const res = await call(admin, 'PUT', `${D()}/sla/${frtId}`, {
        name: 'Time to first response', metric: 'first_response', calendarId: alwaysId, warningPercent: 80,
        startConditions: [{ event: 'issue_created' }], pauseConditions: [], stopConditions: [{ event: 'comment_agent' }],
        goals: [
          { criteria: { priorityIds: [seeded.priority.id] }, targetMinutes: 30, jql: 'labels = vip' },
          { criteria: {}, targetMinutes: 120 },
          { criteria: { issueTypeIds: [seeded.issueType.id] }, targetMinutes: 60, calendarId: sampleId },
        ],
      });
      expect(res.status).toBe(200);
      const sla = await res.json();
      expect(sla.goals.map((g: any) => g.targetMinutes)).toEqual([30, 120, 60]);
      expect(sla.goals[2].calendarId).toBe(sampleId);
      expect(sla.goals[0].jql).toBe('labels = vip');
      const list = (await (await call(admin, 'GET', `${D()}/sla`)).json()).values;
      expect(list.find((s: any) => s.id === frtId).goals).toHaveLength(3);
      expect((await call(admin, 'PUT', `${D()}/sla/999999`, { name: 'x', goals: [{ targetMinutes: 1 }] })).status).toBe(404);
    });

    test('legacy-style SLA still works and exposes its effective conditions', async () => {
      const res = await call(admin, 'POST', `${D()}/sla`, {
        name: 'Legacy TTR', metric: 'resolution', calendar: 'business', pauseStatusIds: [waitingId], goals: [{ priorityId: null, targetMinutes: 480 }],
      });
      expect(res.status).toBe(201);
      const sla = await res.json();
      expect(sla.usesLegacyConditions).toBe(true);
      expect(sla.effectiveConditions.stop).toEqual([{ event: 'resolution_set' }]);
      expect(sla.effectiveConditions.pause).toEqual([{ event: 'status_entered', statusIds: [waitingId] }]);
      expect(sla.calendar).toBe('business');
      // listing back-fills a calendar for the legacy SLA
      const list = (await (await call(admin, 'GET', `${D()}/sla`)).json()).values;
      const legacy = list.find((s: any) => s.id === sla.id);
      expect(legacy.calendarId).not.toBeNull();
      const cals = (await (await call(admin, 'GET', `${D()}/calendar`)).json()).values;
      expect(cals.find((c: any) => c.id === legacy.calendarId).name).toBe('Business hours (migrated)');
      await call(admin, 'DELETE', `${D()}/sla/${sla.id}`);
    });

    test('agents can read SLAs but not change them', async () => {
      expect((await call(agent, 'GET', `${D()}/sla`)).status).toBe(200);
      expect((await call(agent, 'POST', `${D()}/sla`, { name: 'x', goals: [{ targetMinutes: 1 }] })).status).toBe(403);
      expect((await call(agent, 'DELETE', `${D()}/sla/${frtId}`)).status).toBe(403);
      expect((await call(alice, 'GET', `${D()}/sla`)).status).toBe(404);
    });

    test('calendar in use by an SLA cannot be deleted', async () => {
      expect((await call(admin, 'DELETE', `${D()}/calendar/${sampleId}`)).status).toBe(409); // used by a goal
      expect((await call(admin, 'DELETE', `${D()}/calendar/${calId}`)).status).toBe(204);
    });

    test('reorder', async () => {
      const second = await (await call(admin, 'POST', `${D()}/sla`, { name: 'Time to resolution', metric: 'resolution', calendarId: alwaysId, goals: [{ targetMinutes: 600 }] })).json();
      let res = await call(admin, 'PUT', `${D()}/sla-order`, { ids: [second.id, frtId] });
      expect(res.status).toBe(204);
      const list = (await (await call(admin, 'GET', `${D()}/sla`)).json()).values;
      expect(list.map((s: any) => s.id)).toEqual([second.id, frtId]);
      res = await call(admin, 'PUT', `${D()}/sla-order`, { ids: [frtId] });
      expect(res.status).toBe(400);
      await call(admin, 'DELETE', `${D()}/sla/${second.id}`);
    });

    test('first matching goal decides the target; criteria and JQL are honoured', async () => {
      // goals: [priority=Medium + JQL labels=vip -> 30], [any -> 120], [type -> 60 (never reached)]
      const plain = await newRequest('no label', 10);
      let sla = (await slaFor(plain.key))[0];
      expect(sla.targetMs).toBe(120 * 60_000); // JQL does not match -> falls to "all remaining"
      expect(sla.status).toBe('running');
      expect(sla.calendar).toBe('24/7');

      const db = createTestDb(testSql);
      const [lbl] = await db.insert(schema.labels).values({ name: 'vip' }).returning();
      await db.insert(schema.issueLabels).values({ issueId: plain.id, labelId: lbl.id });
      sla = (await slaFor(plain.key))[0];
      expect(sla.targetMs).toBe(30 * 60_000);
    });

    test('engine through the API: customer comment does not stop first response, agent public comment does, internal notes do not', async () => {
      const r = await newRequest('engine test', 40);
      const db = createTestDb(testSql);
      // no label -> goal 120min, 40 min elapsed, 80% warning at 96min
      let sla = (await slaFor(r.key))[0];
      expect(sla.status).toBe('running');
      expect(sla.elapsedMs).toBeGreaterThan(39 * 60_000);
      expect(sla.dueAt).toBeTruthy();
      expect(new Date(sla.dueAt).getTime()).toBeGreaterThan(Date.now());

      await resetLimits();
      let res = await call(alice, 'POST', `/rest/servicedeskapi/portal/sla-desk/request/${r.key}/comment`, { body: 'any news?' });
      expect(res.status).toBe(201);
      res = await call(admin, 'POST', `/rest/api/2/issue/${r.key}/comment`, { body: 'internal only', internal: true });
      expect(res.status).toBe(201);
      sla = (await slaFor(r.key))[0];
      expect(sla.status).toBe('running');
      expect(sla.stoppedAt).toBeNull();

      res = await call(admin, 'POST', `/rest/api/2/issue/${r.key}/comment`, { body: 'Looking into it' });
      expect(res.status).toBe(201);
      sla = (await slaFor(r.key))[0];
      expect(sla.status).toBe('met');
      expect(sla.stoppedAt).toBeTruthy();
      expect(sla.dueAt).toBeNull();
      expect(db).toBeTruthy();
    });

    test('warning state and breach notification once per request and SLA', async () => {
      const r = await newRequest('warn', 100); // 100 of 120 minutes = 83% -> warning
      let sla = (await slaFor(r.key))[0];
      expect(sla.status).toBe('warning');
      expect(sla.breached).toBe(false);

      const before = (await createTestDb(testSql).select().from(schema.emailQueue)).length;
      const old = await newRequest('overdue', 300); // 5h > 2h
      sla = (await slaFor(old.key))[0];
      expect(sla.status).toBe('breached');
      expect(new Date(sla.dueAt).getTime()).toBeLessThan(Date.now());

      const n = await checkSlaBreaches();
      expect(n).toBeGreaterThanOrEqual(1);
      expect(await checkSlaBreaches()).toBe(0);
      const mails = await createTestDb(testSql).select().from(schema.emailQueue);
      expect(mails.length).toBeGreaterThan(before);
      expect(mails.filter((m) => m.subject === `SLA Breached: ${old.key}`)).toHaveLength(1);
    });

    test('a warning is sent once when the threshold is reached, and the breach still follows later', async () => {
      const r = await newRequest('warn-mail', 100); // 100 of 120 minutes -> warning
      const db = createTestDb(testSql);
      await db.update(schema.issues).set({ assigneeId: seeded.user.id }).where(eq(schema.issues.issueKey, r.key));
      const first = await checkSla();
      expect(first.warned).toBeGreaterThanOrEqual(1);
      expect((await checkSla()).warned).toBe(0);
      let mails = await db.select().from(schema.emailQueue);
      expect(mails.filter((m) => m.subject === `SLA at risk: ${r.key}`)).toHaveLength(1);
      expect(mails.filter((m) => m.subject === `SLA Breached: ${r.key}`)).toHaveLength(0);

      // time passes: the same request is now past its goal. The earlier warning must not swallow the breach notification.
      await db.update(schema.issues).set({ createdAt: new Date(Date.now() - 300 * 60_000) }).where(eq(schema.issues.issueKey, r.key));
      const later = await checkSla();
      expect(later.breached).toBeGreaterThanOrEqual(1);
      expect((await checkSla()).breached).toBe(0);
      mails = await db.select().from(schema.emailQueue);
      expect(mails.filter((m) => m.subject === `SLA Breached: ${r.key}`)).toHaveLength(1);
      expect(mails.filter((m) => m.subject === `SLA at risk: ${r.key}`)).toHaveLength(1);
    });

    test('pause on waiting status, restart condition and resolution stop', async () => {
      const res = await call(admin, 'POST', `${D()}/sla`, {
        name: 'Time to resolution (custom)', metric: 'custom', calendarId: alwaysId,
        startConditions: [{ event: 'issue_created' }, { event: 'status_entered', statusIds: [seeded.status.id], restart: true }],
        pauseConditions: [{ event: 'waiting_for_customer' }],
        stopConditions: [{ event: 'resolution_set' }],
        goals: [{ targetMinutes: 600 }],
      });
      expect(res.status).toBe(201);
      const slaId = (await res.json()).id;
      const r = await newRequest('pausing', 180);
      const db = createTestDb(testSql);
      const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000);
      // waiting from 120 to 60 minutes ago: 60 minutes do not count
      await db.insert(schema.issueHistory).values([
        { issueId: r.id, fieldName: 'status', oldValue: 'To Do', newValue: 'Waiting for customer', createdAt: at(120) },
        { issueId: r.id, fieldName: 'status', oldValue: 'Waiting for customer', newValue: 'In Progress', createdAt: at(60) },
      ]);
      let s = (await slaFor(r.key)).find((x) => x.slaId === slaId);
      expect(Math.round(s.elapsedMs / 60_000)).toBe(120);
      expect(s.status).toBe('running');

      // back to "To Do" 30 minutes ago restarts the clock
      await db.insert(schema.issueHistory).values({ issueId: r.id, fieldName: 'status', oldValue: 'In Progress', newValue: 'To Do', createdAt: at(30) });
      s = (await slaFor(r.key)).find((x) => x.slaId === slaId);
      expect(Math.round(s.elapsedMs / 60_000)).toBe(30);

      // paused right now
      await db.insert(schema.issueHistory).values({ issueId: r.id, fieldName: 'status', oldValue: 'To Do', newValue: 'Waiting for customer', createdAt: at(10) });
      s = (await slaFor(r.key)).find((x) => x.slaId === slaId);
      expect(s.status).toBe('paused');
      expect(Math.round(s.elapsedMs / 60_000)).toBe(20);
      expect(s.dueAt).toBeNull();

      // resolution stops the clock
      await db.insert(schema.issueHistory).values({ issueId: r.id, fieldName: 'resolution', oldValue: null, newValue: 'Done', createdAt: at(5) });
      await db.update(schema.issues).set({ resolvedAt: at(5) }).where(eq(schema.issues.id, r.id));
      s = (await slaFor(r.key)).find((x) => x.slaId === slaId);
      expect(s.status).toBe('met');
    });
  });

  describe('customer portal does not leak SLA configuration', () => {
    test('portal responses carry no SLA data and the SLA admin API is closed to customers', async () => {
      const r = await newRequest('leak check', 5);
      await resetLimits();
      for (const url of [
        `/rest/servicedeskapi/portal/sla-desk`,
        `/rest/servicedeskapi/portal/sla-desk/request`,
        `/rest/servicedeskapi/portal/sla-desk/request/${r.key}`,
      ]) {
        const res = await call(alice, 'GET', url);
        expect(res.status).toBe(200);
        const text = await res.text();
        // The request list shows one word per request (overdue, paused, on_track, met or null) next to it; the SLA definitions, goals and calendars must never reach a customer.
        expect(text).not.toMatch(/"sla":[\[{]|slaId|warningPercent|calendar|targetMs|dueAt|stopConditions|startConditions/);
        for (const m of text.matchAll(/"sla":(null|"[a-z_]+")/g)) expect(['null', '"overdue"', '"paused"', '"on_track"', '"met"']).toContain(m[1]);
      }
      expect((await call(alice, 'GET', `/rest/servicedeskapi/request/${r.key}/meta`)).status).toBe(200);
      const meta = await (await call(alice, 'GET', `/rest/servicedeskapi/request/${r.key}/meta`)).json();
      expect(meta).toEqual({ isRequest: false, staff: false });
      for (const path of ['sla', 'calendar']) expect((await call(alice, 'GET', `${D()}/${path}`)).status).toBe(404);
    });
  });
});
