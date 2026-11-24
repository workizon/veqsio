/**
 * Whether cookies set by the API carry the Secure flag. Secure on every HTTPS deployment; an installation served over plain
 * HTTP (installer option `http://host:port`) must not set it, or the browser drops the session cookie and nobody can sign in.
 * COOKIE_SECURE=true|false overrides the guess.
 */
export function secureCookies(env: Record<string, string | undefined> = process.env): boolean {
  const forced = env['COOKIE_SECURE'];
  if (forced === 'true') return true;
  if (forced === 'false') return false;
  if (env['NODE_ENV'] !== 'production') return false;
  const url = env['WEB_URL'] || env['PUBLIC_URL'] || env['BASE_URL'] || '';
  return !url.toLowerCase().startsWith('http://');
}
