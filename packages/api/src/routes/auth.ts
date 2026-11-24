import { Hono } from 'hono';
import { sessionMiddleware, requireAuth } from '../auth/middleware';
import { login } from '../auth/service';
import { requestPasswordReset, confirmPasswordReset } from '../auth/password-reset';
import { getClientIP } from '../middleware/rate-limit';
import { loginRetryAfter, recordLoginFailure, clearLoginFailures } from '../auth/login-throttle';
import { setCookie, deleteCookie, getCookie } from 'hono/cookie';
import { deleteSession } from '../auth/session';
import type { AppContext } from '../auth/middleware';
import { secureCookies } from '../lib/cookie-security';

const app = new Hono<AppContext>();

app.post('/rest/auth/1/session', async (c) => {
  const body = await c.req.json().catch(() => null);
  // Credentials must be non-empty strings: anything else is a client error (never a database error)
  if (!body || typeof body.username !== 'string' || typeof body.password !== 'string' || !body.username || !body.password) {
    return c.json({ errorMessages: ['username and password are required'] }, 400);
  }
  if (body.username.length > 255 || body.password.length > 1024) {
    return c.json({ errorMessages: ['Login failed'] }, 401);
  }
  const ip = getClientIP(c);
  const retryAfter = await loginRetryAfter(ip, body.username);
  if (retryAfter > 0) {
    c.header('Retry-After', String(retryAfter));
    return c.json({ errorMessages: [`Too many failed login attempts. Try again in ${retryAfter} seconds.`] }, 429);
  }
  const result = await login(body.username, body.password);
  if (!result) {
    await recordLoginFailure(ip, body.username);
    return c.json({ errorMessages: ['Login failed'] }, 401);
  }
  await clearLoginFailures(ip, body.username);
  setCookie(c, 'session', result.sessionId, {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: 'Lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  });
  return c.json({
    session: { name: 'session', value: result.sessionId },
    loginInfo: {
      failedLoginCount: 0,
      loginCount: 1,
    },
  });
});

app.delete('/rest/auth/1/session', sessionMiddleware, requireAuth, async (c) => {
  // end the session on the server, not only in the browser: a copied cookie must stop working at sign-out
  const sid = getCookie(c, 'session');
  if (sid) await deleteSession(sid).catch(() => {});
  deleteCookie(c, 'session');
  return c.json({});
});

function clientIp(c: any): string {
  return getClientIP(c);
}

// Request a password reset email. Always returns the same response to avoid user enumeration.
app.post('/rest/auth/1/password-reset/request', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = typeof body?.email === 'string' ? body.email : '';
  const ip = clientIp(c);
  // Process in the background so response timing does not reveal whether the account exists.
  void requestPasswordReset(email, ip).catch((err) => console.error('[password-reset] request failed', err));
  return c.json({ message: 'If an account with that email exists, a password reset link has been sent.' });
});

// Confirm a password reset with the emailed token and a new password.
app.post('/rest/auth/1/password-reset/confirm', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const result = await confirmPasswordReset(body?.token, body?.password, clientIp(c));
  if (!result.ok) {
    return c.json({ errorMessages: [result.message] }, result.status);
  }
  deleteCookie(c, 'session');
  return c.json({ message: 'Password has been reset. Please sign in with your new password.' });
});

export default app;
