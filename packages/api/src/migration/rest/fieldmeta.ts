import type { JiraClient } from './client'

/**
 * Where a Jira custom field applies (its contexts: projects and issue types) and which values a list field offers.
 * Jira Cloud answers this through the field context API; Jira Data Center has no such API, so the contexts and the allowed values
 * are read from the create metadata of each project (the field is present for a project and issue type when it applies there).
 */

export interface JiraOption { value: string; /** value of the parent option of a cascading list */ parent?: string; disabled?: boolean }

export interface JiraContextMeta {
  /** Applies to every project and every issue type. */
  global: boolean
  /** Project keys the context is limited to (empty when global). */
  projectKeys: string[]
  /** Issue type names it is limited to; null for any type. */
  issueTypeNames: string[] | null
  options: JiraOption[]
  /** Value of the default option, when Jira has one. */
  defaultValue?: string
}

export type FieldMetaSource = 'cloud-context-api' | 'createmeta'
export interface FieldMeta { source: FieldMetaSource; contexts: JiraContextMeta[] }

type Getter = Pick<JiraClient, 'get'>

async function pagedValues(c: Getter, path: string, params: Record<string, string | number | undefined> = {}): Promise<any[]> {
  const out: any[] = []
  for (let startAt = 0, guard = 0; guard < 200; guard++) {
    const page: any = await c.get(path, { ...params, startAt, maxResults: 100 })
    const values: any[] = Array.isArray(page?.values) ? page.values : []
    out.push(...values)
    if (page?.isLast !== false || values.length === 0) break
    startAt += values.length
  }
  return out
}

/** Flattens Jira's option list (cascading children have `optionId`, the id of their parent) into values with the parent's value. */
export function parseOptions(raw: any[]): JiraOption[] {
  const byId = new Map<string, string>()
  for (const o of raw) if (o?.id !== undefined && o.value) byId.set(String(o.id), String(o.value))
  const out: JiraOption[] = []
  for (const o of raw) {
    if (!o?.value) continue
    const parent = o.optionId !== undefined && o.optionId !== null ? byId.get(String(o.optionId)) : undefined
    out.push({ value: String(o.value), ...(parent ? { parent } : {}), ...(o.disabled ? { disabled: true } : {}) })
  }
  return out
}

/** Jira Cloud: contexts, their projects and issue types, options and default value. Returns null when the API is not there (Data Center, or no rights). */
export async function fetchCloudContexts(
  c: Getter, fieldId: string, projectKeyById: Map<string, string>, issueTypeNameById: Map<string, string>,
): Promise<JiraContextMeta[] | null> {
  let contexts: any[]
  try { contexts = await pagedValues(c, `/rest/api/2/field/${encodeURIComponent(fieldId)}/context`) } catch { return null }
  const out: JiraContextMeta[] = []
  for (const ctx of contexts) {
    const id = String(ctx.id)
    const q = { contextId: id }
    const [projMap, typeMap, optionRaw, defaults] = await Promise.all([
      ctx.isGlobalContext ? Promise.resolve([]) : pagedValues(c, `/rest/api/2/field/${encodeURIComponent(fieldId)}/context/projectmapping`, q).catch(() => []),
      ctx.isAnyIssueType ? Promise.resolve([]) : pagedValues(c, `/rest/api/2/field/${encodeURIComponent(fieldId)}/context/issuetypemapping`, q).catch(() => []),
      pagedValues(c, `/rest/api/2/field/${encodeURIComponent(fieldId)}/context/${encodeURIComponent(id)}/option`).catch(() => []),
      pagedValues(c, `/rest/api/2/field/${encodeURIComponent(fieldId)}/context/defaultValue`, q).catch(() => []),
    ])
    const options = parseOptions(optionRaw)
    const def = defaults.find((d: any) => String(d?.contextId) === id)
    const defOpt = def?.optionId !== undefined ? optionRaw.find((o: any) => String(o.id) === String(def.optionId)) : undefined
    out.push({
      global: !!ctx.isGlobalContext && !!ctx.isAnyIssueType,
      projectKeys: projMap.map((m: any) => projectKeyById.get(String(m.projectId))).filter((k: string | undefined): k is string => !!k),
      issueTypeNames: ctx.isAnyIssueType ? null : typeMap.map((m: any) => issueTypeNameById.get(String(m.issueTypeId))).filter((n: string | undefined): n is string => !!n),
      options,
      ...(defOpt?.value ? { defaultValue: String(defOpt.value) } : {}),
    })
  }
  return out
}

export interface MetaIssueType { name: string; fields: Record<string, any> }
export interface MetaProject { key: string; issuetypes: MetaIssueType[] }

/**
 * Derives contexts from create metadata (Jira Server / Data Center): per project, a field that appears for every issue type is one
 * context for the project, otherwise one context per issue type it appears for. Projects where it never appears are left out.
 * When it applies to every project and every type, it is one global context.
 */
export function contextsFromCreateMeta(fieldId: string, projects: MetaProject[]): JiraContextMeta[] {
  const perProject: Array<{ key: string; types: Array<{ name: string; options: JiraOption[] }>; allTypes: boolean }> = []
  for (const p of projects) {
    const withField = p.issuetypes.filter((t) => t.fields && t.fields[fieldId])
    if (withField.length === 0) continue
    perProject.push({
      key: p.key,
      allTypes: withField.length === p.issuetypes.length,
      types: withField.map((t) => ({ name: t.name, options: parseAllowed(t.fields[fieldId]?.allowedValues) })),
    })
  }
  const union = (lists: JiraOption[][]): JiraOption[] => {
    const seen = new Set<string>(); const out: JiraOption[] = []
    for (const l of lists) for (const o of l) { const k = `${o.parent ?? ''}\u0000${o.value}`; if (!seen.has(k)) { seen.add(k); out.push(o) } }
    return out
  }
  if (perProject.length === projects.length && perProject.length > 0 && perProject.every((p) => p.allTypes)) {
    return [{ global: true, projectKeys: [], issueTypeNames: null, options: union(perProject.flatMap((p) => p.types.map((t) => t.options))) }]
  }
  const out: JiraContextMeta[] = []
  for (const p of perProject) {
    if (p.allTypes) out.push({ global: false, projectKeys: [p.key], issueTypeNames: null, options: union(p.types.map((t) => t.options)) })
    else for (const t of p.types) out.push({ global: false, projectKeys: [p.key], issueTypeNames: [t.name], options: t.options })
  }
  return out
}

/** `allowedValues` of create metadata: options (with `children` for a cascading list) or other objects that carry a name. */
export function parseAllowed(raw: any): JiraOption[] {
  if (!Array.isArray(raw)) return []
  const out: JiraOption[] = []
  for (const o of raw) {
    const value = o?.value ?? o?.name
    if (!value) continue
    out.push({ value: String(value), ...(o.disabled ? { disabled: true } : {}) })
    for (const ch of Array.isArray(o.children) ? o.children : []) {
      const cv = ch?.value ?? ch?.name
      if (cv) out.push({ value: String(cv), parent: String(value), ...(ch.disabled ? { disabled: true } : {}) })
    }
  }
  return out
}

/**
 * Create metadata of the given projects, in one shape whatever Jira offers: the classic `createmeta?expand=projects.issuetypes.fields`
 * (Jira up to 9, and Cloud while it lasts) or, where that is gone (Jira 10 and newer, and Cloud), the per-project and per-issue-type
 * endpoints `createmeta/{project}/issuetypes[/{id}]`, whose fields come as a list instead of a map.
 */
export async function fetchCreateMeta(c: Getter, projectKeys: string[]): Promise<MetaProject[]> {
  const out: MetaProject[] = []
  for (const key of projectKeys) {
    let classic: MetaProject[] = []
    try {
      const r: any = await c.get('/rest/api/2/issue/createmeta', { projectKeys: key, expand: 'projects.issuetypes.fields' })
      classic = (r?.projects ?? []).map((p: any) => ({ key: String(p.key), issuetypes: (p.issuetypes ?? []).map((t: any) => ({ name: String(t.name), fields: t.fields ?? {} })) }))
    } catch { /* removed in newer versions: use the per-type endpoints below */ }
    if (classic.length && classic.some((p) => p.issuetypes.length)) { out.push(...classic); continue }
    out.push(await fetchCreateMetaByType(c, key))
  }
  return out
}

/** `createmeta/{project}/issuetypes` and `.../{issueTypeId}`, paged; the answer lists types under `values` (Data Center) or `issueTypes` (Cloud). */
export async function fetchCreateMetaByType(c: Getter, projectKey: string): Promise<MetaProject> {
  const types: any[] = []
  for (let startAt = 0, guard = 0; guard < 50; guard++) {
    const page: any = await c.get(`/rest/api/2/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`, { startAt, maxResults: 50 })
    const list: any[] = page?.values ?? page?.issueTypes ?? []
    types.push(...list)
    if (list.length === 0 || page?.isLast !== false || types.length >= (page?.total ?? Infinity)) break
    startAt += list.length
  }
  const issuetypes: MetaIssueType[] = []
  for (const t of types) {
    if (t?.id === undefined || !t.name) continue
    const fields: Record<string, any> = {}
    for (let startAt = 0, guard = 0; guard < 50; guard++) {
      const page: any = await c.get(`/rest/api/2/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${encodeURIComponent(String(t.id))}`, { startAt, maxResults: 200 })
      const list: any[] = page?.values ?? page?.fields ?? []
      for (const f of list) { const id = f?.fieldId ?? f?.key; if (id) fields[String(id)] = f }
      if (list.length === 0 || page?.isLast !== false || Object.keys(fields).length >= (page?.total ?? Infinity)) break
      startAt += list.length
    }
    issuetypes.push({ name: String(t.name), fields })
  }
  return { key: projectKey, issuetypes }
}

/** For each field: the (project, issue type) pairs where Jira requires it, read from create metadata. */
export function requiredFromCreateMeta(fieldIds: string[], projects: MetaProject[]): Map<string, Array<{ projectKey: string; issueTypeName: string }>> {
  const out = new Map<string, Array<{ projectKey: string; issueTypeName: string }>>()
  for (const id of fieldIds) {
    const hits: Array<{ projectKey: string; issueTypeName: string }> = []
    for (const p of projects) for (const t of p.issuetypes) if (t.fields?.[id]?.required === true) hits.push({ projectKey: p.key, issueTypeName: t.name })
    if (hits.length) out.set(id, hits)
  }
  return out
}

/**
 * Contexts and options for each of the given Jira fields. Tries the Cloud context API per field and falls back to create metadata of
 * `projectKeys` for the fields it could not answer for. Fields nothing could be read for are left out of the result.
 */
export async function fetchFieldMeta(
  c: Getter, fieldIds: string[], projectKeys: string[], warnings: string[],
): Promise<Map<string, FieldMeta>> {
  const result = new Map<string, FieldMeta>()
  if (fieldIds.length === 0) return result
  const projectKeyById = new Map<string, string>()
  const issueTypeNameById = new Map<string, string>()
  try { for (const p of (await c.get<any[]>('/rest/api/2/project')) ?? []) if (p?.id && p?.key) projectKeyById.set(String(p.id), String(p.key)) } catch { /* the mapping is optional */ }
  try { for (const t of (await c.get<any[]>('/rest/api/2/issuetype')) ?? []) if (t?.id && t?.name) issueTypeNameById.set(String(t.id), String(t.name)) } catch { /* optional */ }

  const needMeta: string[] = []
  for (const id of fieldIds) {
    const ctxs = await fetchCloudContexts(c, id, projectKeyById, issueTypeNameById)
    if (ctxs) result.set(id, { source: 'cloud-context-api', contexts: ctxs })
    else needMeta.push(id)
  }
  if (needMeta.length && projectKeys.length) {
    try {
      const meta = await fetchCreateMeta(c, projectKeys)
      for (const id of needMeta) result.set(id, { source: 'createmeta', contexts: contextsFromCreateMeta(id, meta) })
    } catch (e: any) {
      warnings.push(`Field contexts and list options not imported: neither the field context API nor the create metadata could be read (${String(e?.message ?? e).slice(0, 120)})`)
    }
  }
  return result
}
