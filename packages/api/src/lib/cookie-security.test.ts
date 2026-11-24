import { describe, expect, test } from 'bun:test';
import { secureCookies } from './cookie-security';

describe('secureCookies', () => {
  test('production over HTTPS sets Secure', () => {
    expect(secureCookies({ NODE_ENV: 'production', WEB_URL: 'https://demo.veqsio.com' })).toBe(true);
    expect(secureCookies({ NODE_ENV: 'production' })).toBe(true);
  });
  test('production over plain HTTP (installer option) does not, or nobody could sign in', () => {
    expect(secureCookies({ NODE_ENV: 'production', WEB_URL: 'http://10.0.0.5:8080' })).toBe(false);
  });
  test('development does not', () => {
    expect(secureCookies({ NODE_ENV: 'development', WEB_URL: 'https://x.example' })).toBe(false);
  });
  test('COOKIE_SECURE overrides', () => {
    expect(secureCookies({ NODE_ENV: 'production', WEB_URL: 'http://a', COOKIE_SECURE: 'true' })).toBe(true);
    expect(secureCookies({ NODE_ENV: 'production', WEB_URL: 'https://a', COOKIE_SECURE: 'false' })).toBe(false);
  });
});
