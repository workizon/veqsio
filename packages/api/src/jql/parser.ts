import type { Token, JQLNode, JQLQueryNode, JQLValue, OrderByField } from './types';
import { JQLError, MAX_JQL_LIMIT } from './types';

class Parser {
  private pos = 0;

  constructor(private tokens: Token[]) {}

  private current(): Token {
    return this.tokens[this.pos] ?? this.tokens[this.tokens.length - 1];
  }

  private peek(offset = 0): Token {
    return this.tokens[this.pos + offset] ?? this.tokens[this.tokens.length - 1];
  }

  private advance(): Token {
    return this.tokens[this.pos++] ?? this.tokens[this.tokens.length - 1];
  }

  private match(type: string, value?: string): boolean {
    const t = this.current();
    if (t.type !== type) return false;
    if (value !== undefined && t.value.toUpperCase() !== value.toUpperCase()) return false;
    return true;
  }

  private expect(type: string, value?: string): Token {
    if (!this.match(type, value)) {
      const t = this.current();
      throw new JQLError(
        `Expected ${value ? value : type} but got ${t.type}(${t.value}) at pos ${t.pos}`,
        t.pos,
      );
    }
    return this.advance();
  }

  parse(): JQLQueryNode {
    return this.parseQuery();
  }

  private parseQuery(): JQLQueryNode {
    const where = this.current().type === 'EOF' || this.match('ORDER') || this.atLimit() ? null : this.parseOr();

    const orderBy: OrderByField[] = [];
    if (this.match('ORDER')) {
      this.advance();
      this.expect('BY');
      do {
        const fieldToken = this.expect('WORD');
        let direction: 'ASC' | 'DESC' = 'ASC';
        if (this.match('ASC')) {
          this.advance();
          direction = 'ASC';
        } else if (this.match('DESC')) {
          this.advance();
          direction = 'DESC';
        }
        orderBy.push({ field: fieldToken.value, direction });
      } while (this.match('COMMA') && (this.advance(), true));
    }

    // LIMIT n (after ORDER BY, or directly after the conditions): caps the result set, 1..MAX_JQL_LIMIT.
    let limit: number | undefined;
    if (this.atLimit()) {
      this.advance();
      const n = this.expect('NUMBER');
      const value = Number(n.value);
      if (!Number.isInteger(value) || value < 1 || value > MAX_JQL_LIMIT) {
        throw new JQLError(`LIMIT must be a whole number from 1 to ${MAX_JQL_LIMIT}`, n.pos);
      }
      limit = value;
    }

    if (!this.match('EOF')) {
      const t = this.current();
      throw new JQLError(`Unexpected token ${t.type}(${t.value}) at pos ${t.pos}`, t.pos);
    }

    return limit === undefined ? { type: 'query', where, orderBy } : { type: 'query', where, orderBy, limit };
  }

  private atLimit(): boolean {
    const t = this.current();
    return t.type === 'WORD' && t.value.toUpperCase() === 'LIMIT' && this.peek(1).type === 'NUMBER';
  }

  private parseOr(): JQLNode {
    let left = this.parseAnd();
    while (this.match('OR')) {
      this.advance();
      const right = this.parseAnd();
      left = { type: 'or', clauses: [left, right] };
    }
    return left;
  }

  private parseAnd(): JQLNode {
    let left = this.parseNot();
    while (this.match('AND')) {
      this.advance();
      const right = this.parseNot();
      left = { type: 'and', clauses: [left, right] };
    }
    return left;
  }

  private parseNot(): JQLNode {
    if (this.match('NOT')) {
      this.advance();
      const clause = this.parsePrimary();
      return { type: 'not', clause };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): JQLNode {
    if (this.match('LPAREN')) {
      this.advance();
      const node = this.parseOr();
      this.expect('RPAREN');
      return node;
    }

    // a field named in quotes, as Jira allows for names with spaces: "Customer impact" = High
    if (this.current().type === 'STRING' && this.peek(1).type !== 'EOF' && this.peek(1).type !== 'COMMA' && this.peek(1).type !== 'RPAREN') {
      this.tokens[this.pos] = { ...this.tokens[this.pos], type: 'WORD' }
    }
    const fieldToken = this.peek();
    if (fieldToken.type !== 'WORD') {
      throw new JQLError(`Expected field name but got ${fieldToken.type}(${fieldToken.value})`, fieldToken.pos);
    }

    // CHANGED shorthand: text CHANGED FROM "foo" TO "bar"
    if (this.peek(1).type === 'CHANGED') {
      return this.parseChanged(fieldToken.value);
    }

    // WAS shorthand: status WAS "Open"
    if (this.peek(1).type === 'WAS' || (this.peek(1).type === 'NOT' && this.peek(2).type === 'WAS')) {
      return this.parseWasCondition();
    }

    return this.parseCondition();
  }

  private parseWasCondition(): JQLNode {
    const fieldToken = this.expect('WORD');
    this.expect('WAS');
    let isNot = false;
    if (this.match('NOT')) {
      isNot = true;
      this.advance();
    }

    if (this.match('IN')) {
      this.advance();
      const values = this.parseList();
      const op = isNot ? ('WAS NOT IN' as const) : ('WAS IN' as const);
      return { type: 'condition', field: fieldToken.value, operator: op, value: { type: 'list', values } };
    }

    const value = this.parseValue();
    const op = isNot ? ('WAS NOT' as const) : ('WAS' as const);
    return { type: 'condition', field: fieldToken.value, operator: op, value };
  }

  private parseChanged(field: string): JQLNode {
    this.advance(); // field
    this.advance(); // CHANGED
    let fromValue: JQLValue | undefined;
    let toValue: JQLValue | undefined;
    let duringStart: JQLValue | undefined;
    let duringEnd: JQLValue | undefined;

    while (!this.match('AND') && !this.match('OR') && !this.match('RPAREN') && !this.match('EOF')) {
      if (this.match('FROM')) {
        this.advance();
        fromValue = this.parseValue();
      } else if (this.match('TO')) {
        this.advance();
        toValue = this.parseValue();
      } else if (this.match('DURING')) {
        this.advance();
        const start = this.parseValue();
        this.expect('COMMA');
        const end = this.parseValue();
        duringStart = start;
        duringEnd = end;
      } else {
        this.advance(); // skip unknown
      }
    }

    const node: JQLNode = { type: 'changed', field, from: fromValue, to: toValue };
    if (duringStart && duringEnd) {
      return { ...node, during: [duringStart, duringEnd] };
    }
    return node;
  }

  private parseCondition(): JQLNode {
    const fieldToken = this.expect('WORD');
    const field = fieldToken.value;

    let operator: string;
    if (this.match('NOT') && this.peek(1).type === 'IN') {
      this.advance();
      this.advance();
      operator = 'NOT IN';
    } else if (this.match('NOT') && this.peek(1).type === 'IS' && this.peek(2).type === 'EMPTY') {
      this.advance();
      this.advance();
      this.advance();
      return { type: 'condition', field, operator: 'IS NOT', value: { type: 'empty' } };
    } else if (this.match('NOT') && this.peek(1).type === 'IS' && this.peek(2).type === 'NULL') {
      this.advance();
      this.advance();
      this.advance();
      return { type: 'condition', field, operator: 'IS NOT', value: { type: 'null' } };
    } else if (this.match('IS') && this.peek(1).type === 'NOT' && this.peek(2).type === 'EMPTY') {
      this.advance();
      this.advance();
      this.advance();
      return { type: 'condition', field, operator: 'IS NOT', value: { type: 'empty' } };
    } else if (this.match('IS') && this.peek(1).type === 'NOT' && this.peek(2).type === 'NULL') {
      this.advance();
      this.advance();
      this.advance();
      return { type: 'condition', field, operator: 'IS NOT', value: { type: 'null' } };
    } else if (this.match('IS')) {
      this.advance();
      if (this.match('EMPTY')) {
        this.advance();
        return { type: 'condition', field, operator: 'IS', value: { type: 'empty' } };
      }
      if (this.match('NULL')) {
        this.advance();
        return { type: 'condition', field, operator: 'IS', value: { type: 'null' } };
      }
      throw new JQLError(`Expected EMPTY or NULL after IS`, this.current().pos);
    } else if (this.match('IN')) {
      this.advance();
      operator = 'IN';
    } else if (this.match('OPERATOR')) {
      const opToken = this.advance();
      operator = opToken.value;
    } else if (this.match('NOT')) {
      this.advance();
      const next = this.current();
      if (next.type === 'IN') {
        this.advance();
        operator = 'NOT IN';
      } else if (next.type === 'IS') {
        this.advance();
        if (this.match('EMPTY')) {
          this.advance();
          return { type: 'condition', field, operator: 'IS NOT', value: { type: 'empty' } };
        }
        if (this.match('NULL')) {
          this.advance();
          return { type: 'condition', field, operator: 'IS NOT', value: { type: 'null' } };
        }
        throw new JQLError(`Expected EMPTY or NULL after IS`, this.current().pos);
      } else if (next.type === 'OPERATOR' && next.value === '~') {
        this.advance();
        operator = '!~';
      } else {
        throw new JQLError(`Expected IN, IS, or ~ after NOT`, next.pos);
      }
    } else {
      throw new JQLError(`Expected operator after field ${field}`, this.current().pos);
    }

    if (operator === 'IN' || operator === 'NOT IN') {
      // `field IN func(...)`: a function that returns a list (membersOf, openSprints, linkedIssues, ...)
      if (this.current().type === 'WORD' && this.peek(1).type === 'LPAREN') {
        return { type: 'condition', field, operator: operator as any, value: this.parseFunction() };
      }
      const values = this.parseList();
      return { type: 'condition', field, operator: operator as any, value: { type: 'list', values } };
    }

    const value = this.parseValue();
    return { type: 'condition', field, operator: operator as any, value };
  }

  private parseList(): JQLValue[] {
    this.expect('LPAREN');
    const values: JQLValue[] = [];
    while (!this.match('RPAREN')) {
      values.push(this.parseValue());
      if (this.match('COMMA')) this.advance();
      else break;
    }
    this.expect('RPAREN');
    return values;
  }

  private parseValue(): JQLValue {
    const t = this.current();
    if (t.type === 'STRING') {
      this.advance();
      return { type: 'string', value: t.value };
    }
    if (t.type === 'NUMBER') {
      this.advance();
      return { type: 'number', value: Number(t.value) };
    }
    if (t.type === 'WORD') {
      // function call: currentUser(), startOfDay(), etc.
      if (this.peek(1).type === 'LPAREN') {
        return this.parseFunction();
      }
      // boolean/nullish keywords
      const upper = t.value.toUpperCase();
      if (upper === 'EMPTY') {
        this.advance();
        return { type: 'empty' };
      }
      if (upper === 'NULL') {
        this.advance();
        return { type: 'null' };
      }
      if (upper === 'TRUE') {
        this.advance();
        return { type: 'boolean', value: true };
      }
      if (upper === 'FALSE') {
        this.advance();
        return { type: 'boolean', value: false };
      }
      this.advance();
      return { type: 'string', value: t.value };
    }
    throw new JQLError(`Expected value but got ${t.type}(${t.value})`, t.pos);
  }

  private parseFunction(): JQLValue {
    const nameToken = this.expect('WORD');
    this.expect('LPAREN');
    const args: JQLValue[] = [];
    while (!this.match('RPAREN')) {
      args.push(this.parseValue());
      if (this.match('COMMA')) this.advance();
      else break;
    }
    this.expect('RPAREN');
    return { type: 'function', name: nameToken.value, args };
  }
}

export function parseJQLTokens(tokens: Token[]): JQLQueryNode {
  const parser = new Parser(tokens);
  return parser.parse();
}
