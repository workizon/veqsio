import type { Token, TokenType } from './types';
import { JQLError } from './types';

const KEYWORDS = new Set<string>([
  'AND', 'OR', 'NOT', 'IN', 'IS', 'WAS', 'WERE',
  'CHANGED', 'FROM', 'TO', 'DURING', 'BY',
  'ORDER', 'ASC', 'DESC', 'EMPTY', 'NULL',
]);

const OPERATOR_CHARS = new Set<string>(['=', '!', '~', '>', '<']);

function isIdentStart(ch: string): boolean {
  return /[a-zA-Z_]/.test(ch);
}

function isIdentChar(ch: string): boolean {
  return /[a-zA-Z0-9_-]/.test(ch);
}

function isDigit(ch: string): boolean {
  return /[0-9]/.test(ch);
}

function charType(ch: string): TokenType {
  switch (ch) {
    case '(':
      return 'LPAREN';
    case ')':
      return 'RPAREN';
    case ',':
      return 'COMMA';
    default:
      return 'WORD';
  }
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;

  function peek(offset = 0): string {
    return input[pos + offset] ?? '\0';
  }

  function advance(): string {
    return input[pos++] ?? '\0';
  }

  function skipWhitespace(): void {
    while (/\s/.test(peek())) advance();
  }

  while (pos < input.length) {
    skipWhitespace();
    if (pos >= input.length) break;

    const start = pos;
    const ch = peek();

    // String literal: "..."
    if (ch === '"') {
      advance(); // consume opening quote
      let value = '';
      while (peek() !== '"' && peek() !== '\0') {
        value += advance();
      }
      if (peek() !== '"') {
        throw new JQLError('Unterminated string literal', start);
      }
      advance(); // consume closing quote
      tokens.push({ type: 'STRING', value, pos: start });
      continue;
    }

    // Relative date/time offset such as -7d, 2w, 3h, +1M (units: s m h d w M y); kept as a string token
    {
      const rel = /^[+-]?\d+[smhdwMy](?![A-Za-z0-9_])/.exec(input.slice(pos));
      if (rel) {
        pos += rel[0].length;
        tokens.push({ type: 'STRING', value: rel[0], pos: start });
        continue;
      }
    }

    // Negative number or number
    if (ch === '-' && isDigit(peek(1))) {
      advance();
      let num = '-';
      while (isDigit(peek())) num += advance();
      tokens.push({ type: 'NUMBER', value: num, pos: start });
      continue;
    }

    if (isDigit(ch)) {
      let num = '';
      while (isDigit(peek())) num += advance();
      tokens.push({ type: 'NUMBER', value: num, pos: start });
      continue;
    }

    // Multi-char operators: !=, !~, >=, <=
    if (OPERATOR_CHARS.has(ch)) {
      let op = advance();
      if (ch === '!') {
        if (peek() === '=') op += advance();
        else if (peek() === '~') op += advance();
      } else if ((ch === '>' || ch === '<') && peek() === '=') {
        op += advance();
      }
      tokens.push({ type: 'OPERATOR', value: op, pos: start });
      continue;
    }

    // Parentheses and comma
    if (ch === '(' || ch === ')') {
      tokens.push({ type: charType(ch), value: advance(), pos: start });
      continue;
    }
    if (ch === ',') {
      tokens.push({ type: 'COMMA', value: advance(), pos: start });
      continue;
    }

    // Identifier or keyword
    if (isIdentStart(ch)) {
      let value = '';
      while (isIdentChar(peek())) value += advance();
      const upper = value.toUpperCase();

      // cf[10042], the short way Jira writes a custom field
      if (upper === 'CF' && peek() === '[') {
        const save = pos
        advance()
        let digits = ''
        while (/[0-9]/.test(peek())) digits += advance()
        if (digits && peek() === ']') { advance(); tokens.push({ type: 'WORD', value: `customfield_${digits}`, pos: start }); continue }
        pos = save
      }

      // customfield_123 pattern
      if (/^customfield_\d+$/i.test(value)) {
        tokens.push({ type: 'WORD', value, pos: start });
        continue;
      }

      if (upper === 'ORDER') {
        // ORDER BY is two tokens
        tokens.push({ type: 'ORDER', value: upper, pos: start });
        skipWhitespace();
        if (peek() === 'B' || peek() === 'b') {
          const byStart = pos;
          let byWord = '';
          while (isIdentChar(peek())) byWord += advance();
          if (byWord.toUpperCase() === 'BY') {
            tokens.push({ type: 'BY', value: 'BY', pos: byStart });
          } else {
            // backtrack BY part as regular word
            pos = byStart;
          }
        }
        continue;
      }

      if (KEYWORDS.has(upper)) {
        tokens.push({ type: upper as TokenType, value: upper, pos: start });
      } else {
        tokens.push({ type: 'WORD', value, pos: start });
      }
      continue;
    }

    throw new JQLError(`Unexpected character: ${ch}`, pos);
  }

  tokens.push({ type: 'EOF', value: '', pos: input.length });
  return tokens;
}
