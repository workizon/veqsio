import { Hono } from 'hono';
import { requireAuth } from '../auth/middleware';
import type { AppContext } from '../auth/middleware';
import { issueTicket, TICKET_TTL_SECONDS } from '../realtime/tickets';

const app = new Hono<AppContext>();

// Single-use, 30 s ticket for opening the realtime WebSocket (see realtime/server.ts).
app.post('/rest/api/2/realtime/ticket', requireAuth, async (c) => {
  const user = c.get('user')!;
  const ticket = await issueTicket(user.id);
  c.header('Cache-Control', 'no-store');
  return c.json({ ticket, expiresIn: TICKET_TTL_SECONDS });
});

export default app;
