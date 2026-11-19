import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth, type AppContext } from '../auth/middleware';
import {
  MAX_JQL_LENGTH, MAX_SUGGESTIONS, detectContext, needsLeadingSpace,
  staticSuggestions, validateJql, valueSuggestion,
} from '../jql/autocomplete';
import type { Suggestion } from '../jql/autocomplete';
import { suggestValues } from '../jql/suggestions';

/** Jira-compatible JQL autocomplete endpoints plus validate/complete helpers for the UI. All authenticated. */
const app = new Hono<AppContext>();

// GET /rest/api/2/jql/autocompletedata and /suggestions live in routes/jql-autocomplete.ts (field metadata and
// permission-trimmed value suggestions); this file adds validation and context-aware completion.

const jqlBody = z.object({ jql: z.string().max(MAX_JQL_LENGTH) }).strict();

app.post('/rest/api/2/jql/validate', requireAuth, async (c) => {
  const parsed = jqlBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ errorMessages: ['Invalid request body'] }, 400);
  return c.json(validateJql(parsed.data.jql));
});

const completeBody = z.object({
  jql: z.string().max(MAX_JQL_LENGTH),
  cursor: z.number().int().min(0).max(MAX_JQL_LENGTH).optional(),
}).strict();

/** Context-aware completion for the UI: tells what is being typed and returns ready-to-insert items. */
app.post('/rest/api/2/jql/complete', requireAuth, async (c) => {
  const user = c.get('user')!;
  const parsed = completeBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ errorMessages: ['Invalid request body'] }, 400);
  const { jql } = parsed.data;
  const cursor = parsed.data.cursor ?? jql.length;
  const ctx = detectContext(jql, cursor);
  let items: Suggestion[] = staticSuggestions(ctx);
  if (ctx.kind === 'value' && ctx.field && items.length < MAX_SUGGESTIONS) {
    const vals = await suggestValues(user, ctx.field, ctx.prefix);
    items = [...items, ...vals.map((v) => valueSuggestion(v.value, v.displayName, ctx))].slice(0, MAX_SUGGESTIONS);
  }
  return c.json({
    kind: ctx.kind,
    replaceFrom: ctx.replaceFrom,
    replaceTo: ctx.replaceTo,
    needsLeadingSpace: needsLeadingSpace(jql, ctx),
    suggestions: items,
  });
});

export default app;
