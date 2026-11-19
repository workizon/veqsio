import { db } from '../db';
import * as schema from '@veqsio/db';
import { eq, and, inArray } from 'drizzle-orm';

export async function setCustomFields(issueId: number, fields: Array<{ fieldId: number; value: any }>, ex: any = db) {
  for (const { fieldId, value } of fields) {
    const fieldDef = await ex.select().from(schema.customFields).where(eq(schema.customFields.id, fieldId)).limit(1);
    if (fieldDef.length === 0) continue;

    const type = fieldDef[0].fieldType;
    const insertData: any = { issueId, customFieldId: fieldId };

    if (value === null || value === undefined) {
      await ex
        .delete(schema.customFieldValues)
        .where(and(eq(schema.customFieldValues.issueId, issueId), eq(schema.customFieldValues.customFieldId, fieldId)));
      continue;
    }

    switch (type) {
      case 'string':
        insertData.stringValue = String(value);
        break;
      case 'url':
        // a link that opens in a browser: only http(s). `javascript:` and `data:` would run script when somebody clicks it.
        if (!isHttpUrl(String(value))) throw new Error(`${fieldDef[0].name} must be a web address starting with http:// or https://`);
        insertData.stringValue = String(value);
        break;
      case 'number':
        insertData.numberValue = Number(value);
        break;
      case 'date':
      case 'datetime':
        insertData.dateValue = new Date(value);
        break;
      case 'user':
        insertData.userValue = Number(value);
        break;
      case 'checkbox':
      case 'boolean':
        insertData.booleanValue = Boolean(value);
        break;
      case 'text':
        insertData.textValue = String(value);
        break;
      default:
        insertData.stringValue = String(value);
    }

    const existing = await ex
      .select()
      .from(schema.customFieldValues)
      .where(and(eq(schema.customFieldValues.issueId, issueId), eq(schema.customFieldValues.customFieldId, fieldId)))
      .limit(1);

    if (existing.length > 0) {
      await ex
        .update(schema.customFieldValues)
        .set(insertData)
        .where(eq(schema.customFieldValues.id, existing[0].id));
    } else {
      await ex.insert(schema.customFieldValues).values(insertData);
    }
  }
}

type CustomFieldRow = { id: string; name: string; type: string; value: any };

function toCustomFieldValue(field: typeof schema.customFields.$inferSelect, val: typeof schema.customFieldValues.$inferSelect): CustomFieldRow {
  let value: any = null;
  switch (field.fieldType) {
    case 'string':
    case 'url':
      value = val.stringValue;
      break;
    case 'number':
      value = val.numberValue;
      break;
    case 'date':
    case 'datetime':
      value = val.dateValue;
      break;
    case 'user':
      value = val.userValue;
      break;
    case 'checkbox':
    case 'boolean':
      value = val.booleanValue;
      break;
    case 'text':
      value = val.textValue;
      break;
    default:
      value = val.stringValue;
  }
  return { id: `customfield_${field.id}`, name: field.name, type: field.fieldType, value };
}

/** Custom field values for many issues in one query (keyed by issue id; issues without values are absent). */
export async function getCustomFieldsBulk(issueIds: number[]): Promise<Map<number, CustomFieldRow[]>> {
  const out = new Map<number, CustomFieldRow[]>();
  if (issueIds.length === 0) return out;
  const values = await db
    .select()
    .from(schema.customFieldValues)
    .innerJoin(schema.customFields, eq(schema.customFields.id, schema.customFieldValues.customFieldId))
    .where(inArray(schema.customFieldValues.issueId, issueIds));
  for (const v of values) {
    const row = toCustomFieldValue(v.custom_fields, v.custom_field_values);
    const list = out.get(v.custom_field_values.issueId);
    if (list) list.push(row);
    else out.set(v.custom_field_values.issueId, [row]);
  }
  return out;
}

export async function getCustomFields(issueId: number) {
  return (await getCustomFieldsBulk([issueId])).get(issueId) ?? [];
}

/** A web address that is safe to put in a link: http or https, no spaces or control characters. */
export function isHttpUrl(raw: string): boolean {
  const v = raw.trim()
  if (v.length > 2000 || /[\u0000-\u001f\u007f\s]/.test(v)) return false
  try { const u = new URL(v); return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname } catch { return false }
}
