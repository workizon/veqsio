import { describe, it, expect } from 'bun:test';
import { normalizeSeverity, parseAlert, hashAlertKey, newAlertKey } from './alerts';

describe('alerts', () => {
  it('maps severities, unknown means high', () => {
    expect(normalizeSeverity('P1')).toBe('critical');
    expect(normalizeSeverity('Warning')).toBe('medium');
    expect(normalizeSeverity('???')).toBe('high');
    expect(normalizeSeverity(undefined)).toBe('high');
  });
  it('parses payloads, dedups on title by default and detects recovery', () => {
    expect(parseAlert({ title: ' CPU high ', severity: 'error' })).toEqual({ title: 'CPU high', description: null, severity: 'high', dedupKey: 'CPU high', resolved: false });
    expect(parseAlert({ summary: 'x', dedupKey: 'k1', status: 'RESOLVED' })).toMatchObject({ dedupKey: 'k1', resolved: true });
    expect(typeof parseAlert({})).toBe('string');
    expect(typeof parseAlert([])).toBe('string');
  });
  it('keys are random and hashed', () => {
    const a = newAlertKey(); const b = newAlertKey();
    expect(a).not.toBe(b);
    expect(hashAlertKey(a)).toHaveLength(64);
  });
});
