/** Form <-> API conversion for inbound webhook mappings, plus the ready-made presets. Pure, unit tested. */
import type { InboundMapping } from '@/hooks/use-integrations'
import { trNow } from './tr'

export interface MappingForm {
  summary: string
  description: string
  comment: string
  priority: string
  /** One `severity=Priority name` per line. */
  priorityMap: string
  /** One label template per line. */
  labels: string
  dedupKey: string
  idempotencyKey: string
  resolvedPath: string
  /** Comma separated values. */
  resolvedEquals: string
}

export const EMPTY_FORM: MappingForm = { summary: '', description: '', comment: '', priority: '', priorityMap: '', labels: '', dedupKey: '', idempotencyKey: '', resolvedPath: '', resolvedEquals: '' }

export function mappingToForm(m: InboundMapping | null | undefined): MappingForm {
  if (!m) return { ...EMPTY_FORM }
  return {
    summary: m.summary ?? '',
    description: m.description ?? '',
    comment: m.comment ?? '',
    priority: m.priority ?? '',
    priorityMap: Object.entries(m.priorityMap ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
    labels: (m.labels ?? []).join('\n'),
    dedupKey: m.dedupKey ?? '',
    idempotencyKey: m.idempotencyKey ?? '',
    resolvedPath: m.resolvedWhen?.path ?? '',
    resolvedEquals: m.resolvedWhen ? (Array.isArray(m.resolvedWhen.equals) ? m.resolvedWhen.equals : [m.resolvedWhen.equals]).join(', ') : '',
  }
}

export function formToMapping(f: MappingForm): { mapping: InboundMapping } | { error: string } {
  const m: InboundMapping = {}
  const put = (k: 'summary' | 'description' | 'comment' | 'priority' | 'dedupKey' | 'idempotencyKey', v: string) => { if (v.trim()) m[k] = v.trim() }
  put('summary', f.summary); put('description', f.description); put('comment', f.comment); put('priority', f.priority)
  put('dedupKey', f.dedupKey); put('idempotencyKey', f.idempotencyKey)
  const pm: Record<string, string> = {}
  for (const line of f.priorityMap.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const i = line.indexOf('=')
    if (i < 1 || i === line.length - 1) return { error: trNow('Priority map line "{line}" must look like severity=Priority name', { line }) }
    pm[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  if (Object.keys(pm).length) m.priorityMap = pm
  const labels = f.labels.split('\n').map((l) => l.trim()).filter(Boolean)
  if (labels.length) m.labels = labels
  const eq = f.resolvedEquals.split(',').map((v) => v.trim()).filter(Boolean)
  if (f.resolvedPath.trim() || eq.length) {
    if (!f.resolvedPath.trim() || !eq.length) return { error: trNow('Resolved detection needs both a path and at least one value') }
    m.resolvedWhen = { path: f.resolvedPath.trim(), equals: eq.length === 1 ? eq[0] : eq }
  }
  return { mapping: m }
}

export interface Preset { id: string; label: string; type: 'generic' | 'sentry'; mapping: InboundMapping; sample: unknown; hint: string }

export const PRESETS: Preset[] = [
  {
    id: 'generic', label: 'Generic JSON', type: 'generic',
    hint: 'Any system that can POST JSON. Sign the body with HMAC-SHA256 (X-Veqsio-Signature: sha256=<hex>) or use the shared secret header.',
    mapping: { summary: '{{title}}', description: '{{message}}', dedupKey: '{{id}}', priority: '{{severity}}', priorityMap: { critical: 'Highest', high: 'High', medium: 'Medium', low: 'Low' }, resolvedWhen: { path: 'status', equals: ['resolved', 'ok'] } },
    sample: { id: 'job-42', title: 'Nightly backup failed', message: 'Exit code 2 on host db1', severity: 'high', status: 'firing' },
  },
  {
    id: 'grafana', label: 'Grafana alerting', type: 'generic',
    hint: 'Contact point of type Webhook; set the URL and use "Authorization header" or an HMAC proxy. The fingerprint groups repeats of one alert.',
    mapping: {
      summary: '[{{alerts[0].labels.alertname}}] {{alerts[0].annotations.summary | default "Alert"}}',
      description: '{{alerts[0].annotations.description}}\n{{alerts[0].generatorURL}}',
      comment: 'Alert fired again: {{alerts[0].annotations.summary}}',
      priority: '{{alerts[0].labels.severity}}', priorityMap: { critical: 'Highest', warning: 'High', info: 'Low' },
      labels: ['alert', '{{alerts[0].labels.team}}'], dedupKey: '{{alerts[0].fingerprint}}', resolvedWhen: { path: 'status', equals: 'resolved' },
    },
    sample: { status: 'firing', alerts: [{ status: 'firing', labels: { alertname: 'HighCPU', severity: 'critical', team: 'platform' }, annotations: { summary: 'CPU above 90%', description: 'Node a1 is hot' }, fingerprint: 'c0ffee', generatorURL: 'https://grafana.example/alerting/1' }] },
  },
  {
    id: 'github', label: 'GitHub Actions (workflow_run)', type: 'generic',
    hint: 'Repository webhook, event "Workflow runs", content type application/json, secret = the secret below. GitHub signs with X-Hub-Signature-256, which is accepted.',
    mapping: {
      summary: 'CI failed: {{workflow_run.name}} on {{workflow_run.head_branch}}',
      description: 'Run: {{workflow_run.html_url}}\nCommit: {{workflow_run.head_sha}}\nConclusion: {{workflow_run.conclusion}}',
      comment: 'Failed again: {{workflow_run.html_url}}',
      labels: ['ci'], dedupKey: '{{repository.full_name}}:{{workflow_run.name}}:{{workflow_run.head_branch}}',
      resolvedWhen: { path: 'workflow_run.conclusion', equals: 'success' },
    },
    sample: { action: 'completed', workflow_run: { name: 'CI', head_branch: 'main', head_sha: 'abc1234', conclusion: 'failure', html_url: 'https://github.com/acme/app/actions/runs/1' }, repository: { full_name: 'acme/app' } },
  },
  {
    id: 'sentry', label: 'Sentry', type: 'sentry',
    hint: 'Sentry internal integration (or alert rule webhook action). Paste the secret as the integration "Client Secret". The Sentry-Hook-Signature header is verified; no mapping needed.',
    mapping: {},
    sample: { action: 'triggered', data: { event: { issue_id: '4501', title: 'TypeError: x is undefined', culprit: 'app/checkout.js in pay', level: 'error', web_url: 'https://sentry.io/organizations/acme/issues/4501/', environment: 'production' }, triggered_rule: 'Production errors' } },
  },
]
