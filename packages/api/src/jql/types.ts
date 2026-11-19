import type { SQL } from 'drizzle-orm';

export type TokenType =
  | 'WORD'
  | 'STRING'
  | 'NUMBER'
  | 'OPERATOR'
  | 'LPAREN'
  | 'RPAREN'
  | 'COMMA'
  | 'AND'
  | 'OR'
  | 'NOT'
  | 'IN'
  | 'IS'
  | 'WAS'
  | 'CHANGED'
  | 'FROM'
  | 'TO'
  | 'DURING'
  | 'BY'
  | 'ORDER'
  | 'ASC'
  | 'DESC'
  | 'EMPTY'
  | 'NULL'
  | 'EOF';

export interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

export type Operator =
  | '='
  | '!='
  | '~'
  | '!~'
  | '>'
  | '<'
  | '>='
  | '<='
  | 'IN'
  | 'NOT IN'
  | 'IS'
  | 'IS NOT'
  | 'WAS'
  | 'WAS NOT'
  | 'WAS IN'
  | 'WAS NOT IN'
  | 'CHANGED'
  | 'CHANGED FROM'
  | 'CHANGED TO'
  | 'CHANGED FROM TO'
  | 'CHANGED DURING';

export type JQLValue =
  | { type: 'string'; value: string }
  | { type: 'number'; value: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'null' }
  | { type: 'empty' }
  | { type: 'list'; values: JQLValue[] }
  | { type: 'function'; name: string; args: JQLValue[] };

export interface OrderByField {
  field: string;
  direction: 'ASC' | 'DESC';
}

export type JQLNode =
  | { type: 'query'; where: JQLNode | null; orderBy: OrderByField[]; limit?: number }
  | { type: 'and'; clauses: JQLNode[] }
  | { type: 'or'; clauses: JQLNode[] }
  | { type: 'not'; clause: JQLNode }
  | { type: 'condition'; field: string; operator: Operator; value: JQLValue }
  | { type: 'changed'; field: string; from?: JQLValue; to?: JQLValue; during?: [JQLValue, JQLValue] };

/** What the parser returns: always the top-level query node. */
export type JQLQueryNode = Extract<JQLNode, { type: 'query' }>;
/** Alias kept for the public export in index.ts. */
export type JQLOperator = Operator;

export interface JQLContext {
  /** Resolution name (lower case) to id, for `resolution = Done`. */
  resolutionNames?: Record<string, number>;
  currentUserId?: number;
  statusNames?: Record<string, number>;
  priorityNames?: Record<string, number>;
  issueTypeNames?: Record<string, number>;
  projectKeys?: Record<string, number>;
  projectNames?: Record<string, number>;
  userNames?: Record<string, number>;
  groupMembers?: Record<string, number[]>;
  openSprintIds?: number[];
  closedSprintIds?: number[];
  /** Custom field names (lower case) to field id, for `"Customer impact" = High`. */
  customFieldNames?: Record<string, number>;
  /** Jira's own ids of imported custom fields (the N of `cf[N]` and `customfield_N`) to the field id here. */
  customFieldJiraIds?: Record<number, number>;
}

export interface JQLResult {
  where: SQL<unknown> | undefined;
  orderBy: SQL<unknown>[];
  /** `LIMIT n` of the query, if any: the result set never has more than this many issues */
  limit?: number;
}

/** Upper bound of `LIMIT n` (same as the maximum page size of the search API). */
export const MAX_JQL_LIMIT = 1000;

export class JQLError extends Error {
  constructor(message: string, public pos?: number) {
    super(message);
    this.name = 'JQLError';
  }
}
