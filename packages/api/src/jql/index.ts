import { tokenize } from './lexer';
import { parseJQLTokens } from './parser';
import { translateJQL } from './translator';
import type { JQLContext, JQLResult } from './types';
import { JQLError } from './types';

export { tokenize } from './lexer';
export { parseJQLTokens } from './parser';
export { translateJQL } from './translator';
export type { JQLContext, JQLResult, JQLNode, JQLValue, Token, JQLOperator, OrderByField } from './types';
export { JQLError } from './types';

export function parseJQL(jql: string, ctx?: JQLContext): JQLResult {
  const tokens = tokenize(jql);
  const ast = parseJQLTokens(tokens);
  return translateJQL(ast, ctx);
}

export function parseJQLSafe(jql: string, ctx?: JQLContext): { success: true; result: JQLResult } | { success: false; error: string } {
  try {
    const result = parseJQL(jql, ctx);
    return { success: true, result };
  } catch (err) {
    const message = err instanceof JQLError ? err.message : String(err);
    return { success: false, error: message };
  }
}
