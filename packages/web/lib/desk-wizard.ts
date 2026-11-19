/** Helpers of the "Create service desk" wizard (pure, unit tested). */

export interface TemplateOption { id: string; title: string; description: string; examples: string }

export const TEMPLATE_OPTIONS: TemplateOption[] = [
  { id: 'it-support', title: 'IT support', description: 'Help people with devices, access and software.', examples: 'Get IT help, Report a problem, Request new software' },
  { id: 'customer-service', title: 'Customer service', description: 'Answer questions and fix problems for your customers.', examples: 'Ask a question, Report a problem, Give feedback' },
  { id: 'hr', title: 'HR', description: 'Handle questions and requests from employees.', examples: 'Ask HR a question, Request time off, Update personal details' },
  { id: 'facilities', title: 'Facilities', description: 'Office, equipment and room requests.', examples: 'Report a facility problem, Book a room or equipment' },
  { id: 'none', title: 'Blank', description: 'Start empty and build your own request types.', examples: 'You add the request types and forms yourself' },
]

/** A template offered by a module (licensed and enabled), as returned by GET /rest/servicedeskapi/desk-templates. */
export interface ExtraTemplate { id: string; title: string; description: string }

/** Built-in options plus module templates, placed before "Blank". Unknown or duplicate ids are ignored. */
export function mergeTemplateOptions(builtin: TemplateOption[], extra: ExtraTemplate[] | undefined): TemplateOption[] {
  const seen = new Set(builtin.map((t) => t.id))
  const added: TemplateOption[] = []
  for (const t of extra ?? []) {
    if (!t || typeof t.id !== 'string' || !/^[a-z][a-z0-9-]{1,48}$/.test(t.id) || seen.has(t.id)) continue
    seen.add(t.id)
    added.push({ id: t.id, title: String(t.title).slice(0, 80), description: String(t.description).slice(0, 300), examples: 'Enterprise template' })
  }
  const blank = builtin.findIndex((t) => t.id === 'none')
  return blank < 0 ? [...builtin, ...added] : [...builtin.slice(0, blank), ...added, ...builtin.slice(blank)]
}

/** `IT Support Desk` -> `ITSD`; `Facilities` -> `FACI`. Always matches the server rule ^[A-Z][A-Z0-9]{1,9}$ or is empty. */
export function suggestProjectKey(name: string): string {
  const words = name.normalize('NFKD').replace(/[^A-Za-z0-9\s]/g, ' ').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return ''
  let key = words.length === 1 ? words[0].slice(0, 4) : words.map((w) => w[0]).join('').slice(0, 6)
  key = key.toUpperCase().replace(/^[0-9]+/, '')
  return key.length >= 2 ? key : (key + 'X').slice(0, 2)
}

export const isValidProjectKey = (k: string) => /^[A-Z][A-Z0-9]{1,9}$/.test(k)

export function slugify(name: string): string {
  const s = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return s.length >= 2 ? s : ''
}

export const isValidSlug = (s: string) => /^[a-z0-9][a-z0-9-]{1,98}$/.test(s)

export interface WizardInput { name: string; key: string; slug: string; mode: 'new' | 'existing'; existingKey: string }

/** Field-keyed messages; empty object = ready to create. */
export function validateWizard(i: WizardInput): Record<string, string> {
  const e: Record<string, string> = {}
  if (!i.name.trim()) e.name = 'Enter a name'
  if (i.mode === 'new' && !isValidProjectKey(i.key)) e.key = 'Use 2 to 10 capital letters or digits, starting with a letter'
  if (i.mode === 'existing' && !i.existingKey) e.existingKey = 'Choose a project'
  if (!isValidSlug(i.slug)) e.slug = 'Use lower-case letters, digits and dashes (at least 2 characters)'
  return e
}
