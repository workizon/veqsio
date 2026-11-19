import { describe, test, expect } from 'bun:test';
import { createHmac } from 'crypto';
import { extractAgentMentions, newAgentMentions, matchTrigger, limitViolation, nextChainDepth, canReport, type AgentLite, type EventFacts } from './logic';
import { signPayload, verifySignature } from '../plugins/signing';

const agent: AgentLite = { id: 1, userId: 10, username: 'agent:bot', enabled: true, triggers: ['assigned', 'mentioned', 'status_changed', 'commented'] };
const ev = (o: Partial<EventFacts> = {}): EventFacts => ({ actorUserId: 5, assigneeUserId: null, assigneeChanged: false, statusChanged: false, commented: false, mentioned: [], ...o });

describe('mentions', () => {
  test('extracts agent mentions, not emails or look-alikes', () => {
    expect(extractAgentMentions('hi @agent:Bot please, and @agent:other.')).toEqual(['agent:bot', 'agent:other']);
    expect(extractAgentMentions('mail me@agent:bot')).toEqual([]);
    expect(extractAgentMentions('@bob @agent: x')).toEqual([]);
  });
  test('only new mentions count after an edit', () => {
    expect(newAgentMentions('@agent:aa', '@agent:aa and @agent:bb')).toEqual(['agent:bb']);
  });
});

describe('trigger matching and loop protection', () => {
  test('assigned, mentioned, status, comment', () => {
    expect(matchTrigger(agent, ev({ assigneeUserId: 10, assigneeChanged: true }))).toBe('assigned');
    expect(matchTrigger(agent, ev({ mentioned: ['agent:bot'] }))).toBe('mentioned');
    expect(matchTrigger(agent, ev({ assigneeUserId: 10, statusChanged: true }))).toBe('status_changed');
    expect(matchTrigger(agent, ev({ assigneeUserId: 10, commented: true }))).toBe('commented');
    expect(matchTrigger(agent, ev({ commented: true }))).toBeNull(); // not the assignee
  });
  test('own actions never trigger, disabled and unselected triggers do not match', () => {
    expect(matchTrigger(agent, ev({ actorUserId: 10, assigneeUserId: 10, commented: true, mentioned: ['agent:bot'] }))).toBeNull();
    expect(matchTrigger({ ...agent, enabled: false }, ev({ mentioned: ['agent:bot'] }))).toBeNull();
    expect(matchTrigger({ ...agent, triggers: ['assigned'] }, ev({ mentioned: ['agent:bot'] }))).toBeNull();
  });
  test('chain depth', () => {
    expect(nextChainDepth(false, null)).toBe(0);
    expect(nextChainDepth(true, null)).toBe(1);
    expect(nextChainDepth(true, 2)).toBe(3);
  });
});

describe('limits', () => {
  const base = { chainDepth: 0, maxChainDepth: 3, activeForAgent: 0, activeForIssue: 0, startedLastHour: 0, maxConcurrentRuns: 3, maxRunsPerIssue: 1, maxRunsPerHour: 5 };
  test('each guard', () => {
    expect(limitViolation(base)).toBeNull();
    expect(limitViolation({ ...base, chainDepth: 4 })).toMatch(/chain depth/);
    expect(limitViolation({ ...base, activeForIssue: 1 })).toMatch(/on this issue/);
    expect(limitViolation({ ...base, activeForAgent: 3 })).toMatch(/active run/);
    expect(limitViolation({ ...base, startedLastHour: 5 })).toMatch(/per hour/);
  });
  test('report state machine', () => {
    expect(canReport('queued', 'started')).toBe(true);
    expect(canReport('cancelled', 'progress')).toBe(false);
    expect(canReport('succeeded', 'finished')).toBe(false);
  });
});

describe('signing', () => {
  test('signature is HMAC-SHA256 over timestamp.body and verifies; tampering and stale fail', () => {
    const body = '{"a":1}';
    const sig = signPayload('s3cret', 1000, body);
    expect(sig).toBe('v1=' + createHmac('sha256', 's3cret').update('1000.' + body).digest('hex'));
    expect(verifySignature('s3cret', '1000', body, sig, 1000).ok).toBe(true);
    expect(verifySignature('s3cret', '1000', body + ' ', sig, 1000).ok).toBe(false);
    expect(verifySignature('s3cret', '1000', body, sig, 5000).ok).toBe(false);
  });
});
