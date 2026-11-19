import { sql, type SQL } from 'drizzle-orm';
import type { FilterNode } from './filter';
import { ScimError } from './errors';

export interface ColumnSpec {
  expr: SQL;
  kind: 'string' | 'bool' | 'id';
}

/** Escape LIKE wildcards in user input. */
export function likeEscape(v: string): string {
  return v.replace(/[\\%_]/g, (m) => '\\' + m);
}

/** Translate a parsed filter into a SQL condition. Only attributes in `columns` (keys lower-case) are filterable. */
export function filterToSql(node: FilterNode, columns: Record<string, ColumnSpec>): SQL {
  switch (node.type) {
    case 'and': return sql`(${filterToSql(node.left, columns)} and ${filterToSql(node.right, columns)})`;
    case 'or': return sql`(${filterToSql(node.left, columns)} or ${filterToSql(node.right, columns)})`;
    case 'not': return sql`(not ${filterToSql(node.expr, columns)})`;
    case 'pr': {
      const col = columns[node.attr.toLowerCase()];
      if (!col) throw ScimError.invalidFilter(`Unsupported filter attribute "${node.attr}"`);
      return col.kind === 'bool' ? sql`(${col.expr} is not null)` : sql`(${col.expr} is not null and ${col.expr}::text <> '')`;
    }
    case 'cmp': {
      const col = columns[node.attr.toLowerCase()];
      if (!col) throw ScimError.invalidFilter(`Unsupported filter attribute "${node.attr}"`);
      const { op, value } = node;
      if (col.kind === 'bool') {
        if (typeof value !== 'boolean' || (op !== 'eq' && op !== 'ne')) throw ScimError.invalidFilter(`Attribute "${node.attr}" only supports eq/ne with true or false`);
        return op === 'eq' ? sql`(${col.expr} = ${value})` : sql`(${col.expr} <> ${value})`;
      }
      if (typeof value !== 'string') throw ScimError.invalidFilter(`Attribute "${node.attr}" expects a string`);
      // SCIM strings are case-insensitive unless declared otherwise (ids are compared exactly).
      const lhs = col.kind === 'id' ? sql`${col.expr}::text` : sql`lower(${col.expr}::text)`;
      const v = col.kind === 'id' ? value : value.toLowerCase();
      switch (op) {
        case 'eq': return sql`(${lhs} = ${v})`;
        case 'ne': return sql`(${lhs} <> ${v})`;
        case 'co': return sql`(${lhs} like ${'%' + likeEscape(v) + '%'})`;
        case 'sw': return sql`(${lhs} like ${likeEscape(v) + '%'})`;
        case 'ew': return sql`(${lhs} like ${'%' + likeEscape(v)})`;
        case 'gt': return sql`(${lhs} > ${v})`;
        case 'ge': return sql`(${lhs} >= ${v})`;
        case 'lt': return sql`(${lhs} < ${v})`;
        case 'le': return sql`(${lhs} <= ${v})`;
      }
    }
  }
}
