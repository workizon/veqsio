import { and, eq, ilike, sql } from 'drizzle-orm'
import { db } from '../db'
import * as schema from '@veqsio/db'
import type { FieldDef } from './form'
import { getRegisteredDeskTemplate } from './template-registry'

export type DeskTemplate = 'it-support' | 'customer-service' | 'hr' | 'facilities' | 'none'
export const DESK_TEMPLATES = ['it-support', 'customer-service', 'hr', 'facilities', 'none'] as const

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

type FieldSpec = FieldDef
type RequestTypeSpec = { name: string; description: string; helpText: string; icon: string; groupName?: string; fields: FieldSpec[] }

const IT_SUPPORT_REQUEST_TYPES: RequestTypeSpec[] = [
  {
    name: 'Get IT help',
    description: 'Ask a question or get help with an IT problem.',
    helpText: 'Tell us what you need and we will get back to you.',
    icon: 'help-circle',
    fields: [
      { key: 'details', label: 'What do you need help with?', type: 'textarea', required: true },
      { key: 'urgency', label: 'How urgent is it?', type: 'select', options: ['Low', 'Medium', 'High'] },
    ],
  },
  {
    name: 'Report a problem',
    description: 'Something is broken or not working as expected.',
    helpText: 'Include what you were doing and any error message you saw.',
    icon: 'alert-triangle',
    fields: [
      { key: 'affected', label: 'What is affected?', type: 'select', required: true, options: ['Laptop / desktop', 'Network / VPN', 'Email / calendar', 'Business application', 'Other'] },
      { key: 'steps', label: 'What happened?', type: 'textarea', required: true },
      { key: 'blocking', label: 'This stops me from working', type: 'checkbox' },
    ],
  },
  {
    name: 'Request new software',
    description: 'Ask for software to be installed or licensed.',
    helpText: 'Your manager may be asked to approve licensed software.',
    icon: 'package',
    fields: [
      { key: 'software', label: 'Software name', type: 'text', required: true },
      { key: 'justification', label: 'Why do you need it?', type: 'textarea', required: true },
      { key: 'neededBy', label: 'Needed by', type: 'date' },
    ],
  },
]

// Queue JQL is evaluated by the real JQL engine (servicedesk/queue-jql.ts), scoped to the desk's project.
const IT_SUPPORT_QUEUES: Array<{ name: string; jql: string }> = [
  { name: 'All open requests', jql: 'resolution = Unresolved' },
  { name: 'Unassigned', jql: 'resolution = Unresolved AND assignee is EMPTY' },
  { name: 'My open requests', jql: 'resolution = Unresolved AND assignee = currentUser()' },
]

const CUSTOMER_SERVICE_REQUEST_TYPES: RequestTypeSpec[] = [
  {
    name: 'Ask a question', description: 'General questions about our products or services.', helpText: 'We usually reply within one business day.', icon: 'help-circle',
    fields: [
      { key: 'question', label: 'Your question', type: 'textarea', required: true, mapping: { target: 'description' } },
      { key: 'topic', label: 'Topic', type: 'select', options: ['Billing', 'Product', 'Account', 'Other'], mapping: { target: 'labels' } },
    ],
  },
  {
    name: 'Report a problem', description: 'Something is not working as promised.', helpText: 'The more detail you give, the faster we can help.', icon: 'alert-triangle',
    fields: [
      { key: 'what', label: 'What went wrong?', type: 'textarea', required: true },
      { key: 'severity', label: 'How badly does it affect you?', type: 'radio', options: ['Low', 'Medium', 'High'], mapping: { target: 'priority' } },
      { key: 'contactMe', label: 'Please call me back', type: 'checkbox' },
      { key: 'phone', label: 'Phone number', type: 'text', visibleWhen: { field: 'contactMe', op: 'equals', value: true } },
    ],
  },
  {
    name: 'Give feedback', description: 'Tell us what we could do better.', helpText: 'Thank you for helping us improve.', icon: 'message-square',
    fields: [{ key: 'feedback', label: 'Your feedback', type: 'textarea', required: true }],
  },
]

const HR_REQUEST_TYPES: RequestTypeSpec[] = [
  {
    name: 'Ask HR a question', description: 'Policies, benefits, payroll or anything else.', helpText: 'Your request is only visible to the HR team.', icon: 'help-circle',
    fields: [{ key: 'question', label: 'Your question', type: 'textarea', required: true }],
  },
  {
    name: 'Request time off', description: 'Vacation, sick leave or special leave.', helpText: 'Your manager is informed once HR approves.', icon: 'calendar',
    fields: [
      { key: 'kind', label: 'Type of leave', type: 'select', required: true, options: ['Vacation', 'Sick leave', 'Parental leave', 'Other'], mapping: { target: 'labels' } },
      { key: 'from', label: 'First day', type: 'date', required: true },
      { key: 'to', label: 'Last day', type: 'date', required: true, mapping: { target: 'dueDate' } },
      { key: 'comment', label: 'Comment', type: 'textarea' },
    ],
  },
  {
    name: 'Update personal details', description: 'Address, bank account or emergency contact changed.', helpText: 'We never ask for passwords.', icon: 'user',
    fields: [{ key: 'change', label: 'What changed?', type: 'textarea', required: true }],
  },
]

const FACILITIES_REQUEST_TYPES: RequestTypeSpec[] = [
  {
    name: 'Report a facility problem', description: 'Broken equipment, climate, cleaning or safety issues.', helpText: 'For emergencies call the front desk.', icon: 'alert-triangle',
    fields: [
      { key: 'location', label: 'Where is it?', type: 'text', required: true },
      { key: 'issue', label: 'What is the problem?', type: 'textarea', required: true },
      { key: 'photo', label: 'Photo', type: 'attachment' },
    ],
  },
  {
    name: 'Book a room or equipment', description: 'Meeting rooms, projectors and event set-up.', helpText: 'Bookings are confirmed by the facilities team.', icon: 'calendar',
    fields: [
      { key: 'what', label: 'What do you need?', type: 'text', required: true },
      { key: 'when', label: 'When?', type: 'datetime', required: true, mapping: { target: 'dueDate' } },
      { key: 'attendees', label: 'Number of attendees', type: 'number', validation: { min: 1, max: 500 } },
    ],
  },
]

const TEMPLATE_CONTENT: Record<Exclude<DeskTemplate, 'none'>, { requestTypes: RequestTypeSpec[]; queues: Array<{ name: string; jql: string }> }> = {
  'it-support': { requestTypes: IT_SUPPORT_REQUEST_TYPES, queues: IT_SUPPORT_QUEUES },
  'customer-service': { requestTypes: CUSTOMER_SERVICE_REQUEST_TYPES, queues: IT_SUPPORT_QUEUES },
  hr: { requestTypes: HR_REQUEST_TYPES, queues: IT_SUPPORT_QUEUES },
  facilities: { requestTypes: FACILITIES_REQUEST_TYPES, queues: IT_SUPPORT_QUEUES },
}

export const WAITING_STATUS = 'Waiting for customer'
const FIRST_RESPONSE_MINUTES = 4 * 60
const RESOLUTION_MINUTES = 3 * 8 * 60 // 3 business days of 8 working hours

async function findOrCreateIssueType(tx: Tx): Promise<number> {
  for (const name of ['Service Request', 'Task']) {
    const [t] = await tx.select({ id: schema.issueTypes.id }).from(schema.issueTypes)
      .where(and(ilike(schema.issueTypes.name, name), eq(schema.issueTypes.isSubtask, false))).limit(1)
    if (t) return t.id
  }
  const [created] = await tx.insert(schema.issueTypes).values({ name: 'Service Request', description: 'A request raised through the service desk', isSubtask: false }).returning({ id: schema.issueTypes.id })
  return created.id
}

/**
 * The "Waiting for customer" status is created here (category in_progress) so SLAs can pause on it.
 * NOTE: workflow transitions to/from this status are NOT created; a workflow admin must add them
 * to the project's workflow before agents can move requests into it.
 */
async function findOrCreateWaitingStatus(tx: Tx): Promise<number> {
  const [s] = await tx.select({ id: schema.statuses.id }).from(schema.statuses)
    .where(ilike(schema.statuses.name, WAITING_STATUS)).limit(1)
  if (s) return s.id
  const [created] = await tx.insert(schema.statuses).values({ name: WAITING_STATUS, category: 'in_progress', color: '#FF991F' }).returning({ id: schema.statuses.id })
  return created.id
}

async function run(tx: Tx, deskId: number, template: DeskTemplate) {
  if (template === 'none') return
  // Serialize concurrent applications on the same desk so idempotency holds under races.
  await tx.execute(sql`select pg_advisory_xact_lock(${deskId}::bigint)`)

  const [desk] = await tx.select({ id: schema.serviceDesks.id }).from(schema.serviceDesks).where(eq(schema.serviceDesks.id, deskId)).limit(1)
  if (!desk) throw new Error(`Service desk ${deskId} not found`)

  const issueTypeId = await findOrCreateIssueType(tx)

  // Request types (matched by name within the desk)
  const existingTypes = await tx.select({ name: schema.requestTypes.name }).from(schema.requestTypes).where(eq(schema.requestTypes.serviceDeskId, deskId))
  const haveType = new Set(existingTypes.map((t) => t.name.toLowerCase()))
  let order = existingTypes.length
  const content = TEMPLATE_CONTENT[template]
  for (const rt of content.requestTypes) {
    if (haveType.has(rt.name.toLowerCase())) continue
    await tx.insert(schema.requestTypes).values({ ...rt, serviceDeskId: deskId, issueTypeId, sortOrder: order++ })
  }

  // Queues
  const existingQueues = await tx.select({ name: schema.serviceQueues.name }).from(schema.serviceQueues).where(eq(schema.serviceQueues.serviceDeskId, deskId))
  const haveQueue = new Set(existingQueues.map((q) => q.name.toLowerCase()))
  let qOrder = existingQueues.length
  for (const q of content.queues) {
    if (haveQueue.has(q.name.toLowerCase())) continue
    await tx.insert(schema.serviceQueues).values({ ...q, serviceDeskId: deskId, sortOrder: qOrder++ })
  }

  // SLAs
  const waitingId = await findOrCreateWaitingStatus(tx)
  const existingSlas = await tx.select({ name: schema.slaDefinitions.name }).from(schema.slaDefinitions).where(eq(schema.slaDefinitions.serviceDeskId, deskId))
  const haveSla = new Set(existingSlas.map((s) => s.name.toLowerCase()))
  let sOrder = existingSlas.length
  const slas = [
    { name: 'Time to first response', metric: 'first_response', pauseStatusIds: [] as number[], minutes: FIRST_RESPONSE_MINUTES },
    { name: 'Time to resolution', metric: 'resolution', pauseStatusIds: [waitingId], minutes: RESOLUTION_MINUTES },
  ]
  for (const s of slas) {
    if (haveSla.has(s.name.toLowerCase())) continue
    const [def] = await tx.insert(schema.slaDefinitions).values({
      serviceDeskId: deskId, name: s.name, metric: s.metric, calendar: 'business', pauseStatusIds: s.pauseStatusIds, sortOrder: sOrder++,
    }).returning({ id: schema.slaDefinitions.id })
    await tx.insert(schema.slaGoals).values({ slaId: def.id, priorityId: null, targetMinutes: s.minutes })
  }
}

/**
 * Apply a service desk template to an existing desk. Idempotent (items are matched by name and
 * never duplicated or overwritten) and transactional. Pass `tx` to join an outer transaction.
 */
export async function applyTemplate(deskId: number, projectId: number, template: DeskTemplate | (string & {}), tx?: Tx): Promise<void> {
  if (template === 'none') return
  const registered = getRegisteredDeskTemplate(template)
  if (registered) {
    if (!(await registered.isAvailable())) throw new Error(`Template ${template} is not available`)
    const body = async (t: Tx) => {
      await t.execute(sql`select pg_advisory_xact_lock(${deskId}::bigint)`)
      await registered.apply(t, { deskId, projectId })
    }
    if (tx) return body(tx)
    return db.transaction((t) => body(t))
  }
  if (!(DESK_TEMPLATES as readonly string[]).includes(template)) throw new Error(`Unknown template ${template}`)
  if (tx) return run(tx, deskId, template as DeskTemplate)
  await db.transaction((t) => run(t, deskId, template as DeskTemplate))
}
