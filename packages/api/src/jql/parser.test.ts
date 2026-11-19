import { describe, it, expect } from 'bun:test';
import { tokenize } from './lexer';
import { parseJQLTokens } from './parser';
import { translateJQL, parseRelativeDate } from './translator';
import { parseJQL, parseJQLSafe, JQLError } from './index';

describe('JQL Lexer', () => {
  it('tokenizes simple condition', () => {
    const tokens = tokenize('status = "Open"');
    const types = tokens.map(t => t.type);
    expect(types).toEqual(['WORD', 'OPERATOR', 'STRING', 'EOF']);
    expect(tokens[0].value).toBe('status');
    expect(tokens[1].value).toBe('=');
    expect(tokens[2].value).toBe('Open');
  });

  it('tokenizes AND/OR/NOT', () => {
    const tokens = tokenize('status = "Open" AND priority = "High"');
    const types = tokens.map(t => t.type);
    expect(types).toEqual(['WORD', 'OPERATOR', 'STRING', 'AND', 'WORD', 'OPERATOR', 'STRING', 'EOF']);
  });

  it('tokenizes IN list', () => {
    const tokens = tokenize('status IN ("Open", "Closed")');
    const types = tokens.map(t => t.type);
    expect(types).toEqual(['WORD', 'IN', 'LPAREN', 'STRING', 'COMMA', 'STRING', 'RPAREN', 'EOF']);
  });

  it('tokenizes NOT IN', () => {
    const tokens = tokenize('status NOT IN ("Open")');
    const types = tokens.map(t => t.type);
    expect(types).toEqual(['WORD', 'NOT', 'IN', 'LPAREN', 'STRING', 'RPAREN', 'EOF']);
  });

  it('tokenizes ORDER BY', () => {
    const tokens = tokenize('ORDER BY created DESC');
    const types = tokens.map(t => t.type);
    expect(types).toEqual(['ORDER', 'BY', 'WORD', 'DESC', 'EOF']);
  });

  it('tokenizes function call', () => {
    const tokens = tokenize('assignee = currentUser()');
    const types = tokens.map(t => t.type);
    expect(types).toEqual(['WORD', 'OPERATOR', 'WORD', 'LPAREN', 'RPAREN', 'EOF']);
  });

  it('tokenizes numbers', () => {
    const tokens = tokenize('id = 123');
    const types = tokens.map(t => t.type);
    expect(types).toEqual(['WORD', 'OPERATOR', 'NUMBER', 'EOF']);
  });

  it('tokenizes customfield', () => {
    const tokens = tokenize('customfield_10001 = "foo"');
    expect(tokens[0].type).toBe('WORD');
    expect(tokens[0].value).toBe('customfield_10001');
  });

  it('throws on unterminated string', () => {
    expect(() => tokenize('summary = "unclosed')).toThrow(JQLError);
  });

  it('tokenizes != and !~', () => {
    const tokens = tokenize('status != "Open" AND text !~ "bug"');
    expect(tokens[1].value).toBe('!=');
    expect(tokens[5].value).toBe('!~');
  });

  it('tokenizes >= and <=', () => {
    const tokens = tokenize('id >= 10 AND id <= 20');
    expect(tokens[1].value).toBe('>=');
    expect(tokens[5].value).toBe('<=');
  });

  it('tokenizes EMPTY and NULL', () => {
    const tokens1 = tokenize('assignee IS EMPTY');
    expect(tokens1[1].type).toBe('IS');
    expect(tokens1[2].type).toBe('EMPTY');
    expect(tokens1[2].value).toBe('EMPTY');

    const tokens2 = tokenize('assignee IS NULL');
    expect(tokens2[2].type).toBe('NULL');
  });
});

describe('JQL Parser', () => {
  it('parses simple condition', () => {
    const ast = parseJQLTokens(tokenize('status = "Open"'));
    expect(ast.type).toBe('query');
    expect(ast.where).not.toBeNull();
    expect(ast.where!.type).toBe('condition');
    const cond = ast.where as any;
    expect(cond.field).toBe('status');
    expect(cond.operator).toBe('=');
    expect(cond.value.type).toBe('string');
    expect(cond.value.value).toBe('Open');
  });

  it('parses AND clause', () => {
    const ast = parseJQLTokens(tokenize('a = 1 AND b = 2'));
    expect(ast.where!.type).toBe('and');
  });

  it('parses OR clause', () => {
    const ast = parseJQLTokens(tokenize('a = 1 OR b = 2'));
    expect(ast.where!.type).toBe('or');
  });

  it('parses NOT clause', () => {
    const ast = parseJQLTokens(tokenize('NOT a = 1'));
    expect(ast.where!.type).toBe('not');
  });

  it('parses parenthesized expression', () => {
    const ast = parseJQLTokens(tokenize('(a = 1 OR b = 2) AND c = 3'));
    expect(ast.where!.type).toBe('and');
  });

  it('parses IN list', () => {
    const ast = parseJQLTokens(tokenize('status IN ("Open", "Closed")'));
    const cond = ast.where as any;
    expect(cond.type).toBe('condition');
    expect(cond.operator).toBe('IN');
    expect(cond.value.type).toBe('list');
    expect(cond.value.values.length).toBe(2);
  });

  it('parses NOT IN list', () => {
    const ast = parseJQLTokens(tokenize('status NOT IN ("Open", "Closed")'));
    const cond = ast.where as any;
    expect(cond.operator).toBe('NOT IN');
  });

  it('parses IS EMPTY', () => {
    const ast = parseJQLTokens(tokenize('assignee IS EMPTY'));
    const cond = ast.where as any;
    expect(cond.operator).toBe('IS');
    expect(cond.value.type).toBe('empty');
  });

  it('parses IS NOT EMPTY', () => {
    const ast = parseJQLTokens(tokenize('assignee IS NOT EMPTY'));
    const cond = ast.where as any;
    expect(cond.operator).toBe('IS NOT');
    expect(cond.value.type).toBe('empty');
  });

  it('parses text ~ search', () => {
    const ast = parseJQLTokens(tokenize('text ~ "bug"'));
    const cond = ast.where as any;
    expect(cond.field).toBe('text');
    expect(cond.operator).toBe('~');
  });

  it('parses function values', () => {
    const ast = parseJQLTokens(tokenize('assignee = currentUser()'));
    const cond = ast.where as any;
    expect(cond.value.type).toBe('function');
    expect(cond.value.name).toBe('currentUser');
  });

  it('parses ORDER BY', () => {
    const ast = parseJQLTokens(tokenize('ORDER BY created DESC'));
    expect(ast.where).toBeNull();
    expect(ast.orderBy.length).toBe(1);
    expect(ast.orderBy[0].field).toBe('created');
    expect(ast.orderBy[0].direction).toBe('DESC');
  });

  it('parses multi ORDER BY', () => {
    const ast = parseJQLTokens(tokenize('ORDER BY created DESC, updated ASC'));
    expect(ast.orderBy.length).toBe(2);
    expect(ast.orderBy[1].field).toBe('updated');
    expect(ast.orderBy[1].direction).toBe('ASC');
  });

  it('parses WHERE + ORDER BY', () => {
    const ast = parseJQLTokens(tokenize('status = "Open" ORDER BY created DESC'));
    expect(ast.where).not.toBeNull();
    expect(ast.orderBy.length).toBe(1);
  });

  it('parses WAS condition', () => {
    const ast = parseJQLTokens(tokenize('status WAS "Open"'));
    const cond = ast.where as any;
    expect(cond.operator).toBe('WAS');
  });

  it('parses WAS IN', () => {
    const ast = parseJQLTokens(tokenize('status WAS IN ("Open", "Closed")'));
    const cond = ast.where as any;
    expect(cond.operator).toBe('WAS IN');
  });

  it('parses WAS NOT IN', () => {
    const ast = parseJQLTokens(tokenize('status WAS NOT IN ("Open")'));
    const cond = ast.where as any;
    expect(cond.operator).toBe('WAS NOT IN');
  });

  it('parses CHANGED condition', () => {
    const ast = parseJQLTokens(tokenize('status CHANGED FROM "Open" TO "Closed"'));
    const cond = ast.where as any;
    expect(cond.type).toBe('changed');
    expect(cond.field).toBe('status');
    expect(cond.from.value).toBe('Open');
    expect(cond.to.value).toBe('Closed');
  });
});

describe('JQL Translator', () => {
  it('translates simple equality', () => {
    const result = parseJQL('status = "Open"');
    expect(result.where).toBeDefined();
    expect(result.orderBy.length).toBe(0);
  });

  it('translates AND', () => {
    const result = parseJQL('status = "Open" AND priority = "High"');
    expect(result.where).toBeDefined();
  });

  it('translates OR', () => {
    const result = parseJQL('status = "Open" OR status = "Closed"');
    expect(result.where).toBeDefined();
  });

  it('translates NOT', () => {
    const result = parseJQL('NOT status = "Open"');
    expect(result.where).toBeDefined();
  });

  it('translates text ~ search', () => {
    const result = parseJQL('text ~ "bug"');
    expect(result.where).toBeDefined();
  });

  it('translates IN list', () => {
    const result = parseJQL('status IN ("Open", "Closed")');
    expect(result.where).toBeDefined();
  });

  it('translates NOT IN list', () => {
    const result = parseJQL('status NOT IN ("Open", "Closed")');
    expect(result.where).toBeDefined();
  });

  it('translates IS EMPTY', () => {
    const result = parseJQL('assignee IS EMPTY');
    expect(result.where).toBeDefined();
  });

  it('translates IS NOT EMPTY', () => {
    const result = parseJQL('assignee IS NOT EMPTY');
    expect(result.where).toBeDefined();
  });

  it('translates ORDER BY', () => {
    const result = parseJQL('ORDER BY created DESC');
    expect(result.where).toBeUndefined();
    expect(result.orderBy.length).toBe(1);
  });

  it('translates currentUser()', () => {
    const result = parseJQL('assignee = currentUser()', { currentUserId: 5 });
    expect(result.where).toBeDefined();
  });

  it('translates customfield condition', () => {
    const result = parseJQL('customfield_10001 = "foo"');
    expect(result.where).toBeDefined();
  });

  it('translates numeric comparisons', () => {
    const result = parseJQL('id > 100 AND id <= 200');
    expect(result.where).toBeDefined();
  });

  it('translates labels field', () => {
    const result = parseJQL('labels = "bug"');
    expect(result.where).toBeDefined();
  });

  it('translates components field', () => {
    const result = parseJQL('components = "Backend"');
    expect(result.where).toBeDefined();
  });

  it('translates fixVersion field', () => {
    const result = parseJQL('fixVersion = "1.0.0"');
    expect(result.where).toBeDefined();
  });

  it('translates milestone field with all relational operators', () => {
    for (const q of ['milestone = "Beta"', 'milestone != "Beta"', 'milestone in ("Beta", "GA")', 'milestone not in ("Beta")', 'milestone is EMPTY', 'milestone is not EMPTY', 'milestone ~ "be"']) {
      expect(parseJQL(q).where, q).toBeDefined();
    }
  });

  it('milestone cannot be used to order by', () => {
    expect(() => parseJQL('project = X ORDER BY milestone')).toThrow(JQLError);
  });

  it('translates WAS condition', () => {
    const result = parseJQL('status WAS "Open"');
    expect(result.where).toBeDefined();
  });

  it('translates complex query', () => {
    const jql = `text ~ "bug" AND status = "Open" AND assignee = currentUser() ORDER BY created DESC`;
    const result = parseJQL(jql, { currentUserId: 5 });
    expect(result.where).toBeDefined();
    expect(result.orderBy.length).toBe(1);
  });

  it('rejects unknown field', () => {
    expect(() => parseJQL('unknownField = "x"')).toThrow(JQLError);
  });

  it('parseJQLSafe returns error for bad JQL', () => {
    const result = parseJQLSafe('unknownField = "x"');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Unknown field');
    }
  });

  it('parseJQLSafe returns success for good JQL', () => {
    const result = parseJQLSafe('status = "Open"');
    expect(result.success).toBe(true);
  });
});

describe('relative dates and sprint/parent fields', () => {
  it('relative offsets tokenize as one value', () => {
    const r = parseJQL('updated >= -7d AND created < 2w', { currentUserId: 1, groupMembers: {} })
    expect(r).toBeDefined()
  })

  it('sprint and parent clauses parse', () => {
    for (const q of ['sprint = 12', 'sprint = "Sprint 3"', 'sprint in (1, 2)', 'sprint is EMPTY', 'sprint is not EMPTY', 'parent = DEMO-1', 'parent in (DEMO-1, DEMO-2)', 'parent is EMPTY', 'sprint is EMPTY ORDER BY priority DESC, created DESC']) {
      expect(() => parseJQL(q, { currentUserId: 1, groupMembers: {} })).not.toThrow()
    }
  })

  it('parseRelativeDate handles units and rejects text', () => {
    const now = new Date('2026-11-10T12:00:00Z')
    expect(parseRelativeDate('-7d', now)?.toISOString()).toBe('2026-11-03T12:00:00.000Z')
    expect(parseRelativeDate('2w', now)?.toISOString()).toBe('2026-11-24T12:00:00.000Z')
    expect(parseRelativeDate('-1M', now)?.toISOString()).toBe('2026-10-10T12:00:00.000Z')
    expect(parseRelativeDate('-3h', now)?.toISOString()).toBe('2026-11-10T09:00:00.000Z')
    expect(parseRelativeDate('yesterday', now)).toBeNull()
  })
})
