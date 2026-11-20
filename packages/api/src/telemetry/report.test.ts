import { describe, expect, test } from 'bun:test';
import { DEFAULT_URL, deployKind, neverReports, telemetryUrl, usersBucket } from './report';

describe('anonymous usage statistics: the rules that protect privacy', () => {
  test('a production, self-hosted run may report; the demo, cloud tenants, dev runs and an explicit off never do', () => {
    expect(neverReports({ NODE_ENV: 'production' } as any)).toBeNull();
    expect(neverReports({ NODE_ENV: 'production', VEQSIO_TELEMETRY: 'off' } as any)).toContain('VEQSIO_TELEMETRY');
    for (const off of ['off', 'OFF', '0', 'false', 'no', 'disabled']) expect(neverReports({ NODE_ENV: 'production', VEQSIO_TELEMETRY: off } as any)).not.toBeNull();
    expect(neverReports({ NODE_ENV: 'production', VEQSIO_CLOUD: '1' } as any)).toContain('cloud');
    expect(neverReports({ NODE_ENV: 'production', VEQSIO_DEMO: '1' } as any)).toContain('demo');
    expect(neverReports({ NODE_ENV: 'development' } as any)).toContain('production');
    expect(neverReports({} as any)).toContain('production');
  });
  test('the target is https only; anything else falls back to the default', () => {
    expect(telemetryUrl({} as any)).toBe(DEFAULT_URL);
    expect(telemetryUrl({ VEQSIO_TELEMETRY_URL: 'https://stats.example.org/ping' } as any)).toBe('https://stats.example.org/ping');
    expect(telemetryUrl({ VEQSIO_TELEMETRY_URL: 'http://stats.example.org/ping' } as any)).toBe(DEFAULT_URL);
    expect(telemetryUrl({ VEQSIO_TELEMETRY_URL: 'file:///etc/passwd' } as any)).toBe(DEFAULT_URL);
  });
  test('the user count is only ever reported as a range', () => {
    expect([1, 10, 11, 50, 51, 200, 201, 1000, 1001, 50000].map(usersBucket)).toEqual(['1-10', '1-10', '11-50', '11-50', '51-200', '51-200', '201-1000', '201-1000', '1000+', '1000+']);
  });
  test('deployment kind', () => {
    expect(deployKind({ KUBERNETES_SERVICE_HOST: '10.0.0.1' } as any, true)).toBe('kubernetes');
    expect(deployKind({} as any, true)).toBe('docker');
    expect(deployKind({} as any, false)).toBe('other');
  });
});
