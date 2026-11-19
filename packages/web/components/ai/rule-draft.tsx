'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Sparkles } from 'lucide-react'
import { Modal } from '@/components/modal'
import { toast } from '@/components/toast'
import { useCreateAutomationRule } from '@/hooks/use-automation'
import { aiJson, useAiFeatures } from './use-ai'

interface Draft { name: string; triggers: unknown[]; conditions: unknown[]; actions: unknown[]; summary: string[] }
interface Result { draft: Draft; warnings: string[] }

/** "Describe a rule" for the automation page. Shows a draft in plain words; creating it saves the rule DISABLED, ready to edit. Renders nothing when the AI feature is off. */
export function RuleDraftButton() {
  const { enabled, features } = useAiFeatures()
  const router = useRouter()
  const create = useCreateAutomationRule()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  if (!enabled || !features.rule_draft) return null

  const run = async () => {
    setBusy(true); setError(null); setResult(null)
    try { setResult(await aiJson<Result>('POST', '/rest/api/2/automation/ai/draft', { description: text })) }
    catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }
  const save = async () => {
    if (!result) return
    try {
      const rule = await create.mutateAsync({ name: result.draft.name, description: `Drafted by AI from: ${text.slice(0, 300)}`, isEnabled: false, triggers: result.draft.triggers, conditions: result.draft.conditions, actions: result.draft.actions })
      toast('Rule created, switched off. Review it before you enable it.', 'success')
      setOpen(false)
      router.push(`/automation/create?id=${rule.id}`)
    } catch (e) { setError((e as Error).message) }
  }

  return (
    <>
      <button className="veqsio-btn-secondary flex items-center gap-2" onClick={() => setOpen(true)}><Sparkles className="w-4 h-4" aria-hidden /> Describe a rule</button>
      <Modal isOpen={open} onClose={() => setOpen(false)} title="Describe a rule" size="lg">
        <div className="space-y-3">
          <p className="text-body-sm text-[var(--text-secondary)]">Say what should happen, for example: “When a bug is created, label it triage and set the priority to High.” The AI builds a draft from a small set of safe building blocks. You review it; nothing runs until you enable the rule.</p>
          <textarea aria-label="Rule description" className="veqsio-input w-full" rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="flex justify-end"><button className="veqsio-btn-primary" disabled={busy || text.trim().length < 5} onClick={run}>{busy ? 'Drafting…' : 'Draft rule'}</button></div>
          {error && <p role="alert" className="text-body-sm text-[var(--error)]">{error}</p>}
          {result && (
            <div className="space-y-2 rounded-lg border border-[var(--surface-3)] p-3">
              <p className="font-medium">{result.draft.name}</p>
              <ul className="list-disc pl-5 text-body-sm">{result.draft.summary.map((s, i) => <li key={i}>{s}</li>)}</ul>
              {result.warnings.length > 0 && <ul className="text-caption text-[var(--warning,#b45309)]">{result.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
              <p className="text-caption text-[var(--text-tertiary)]">AI-generated draft. Check it before you enable the rule.</p>
              <div className="flex justify-end"><button className="veqsio-btn-primary" disabled={create.isPending} onClick={save}>Create as a disabled rule</button></div>
            </div>
          )}
        </div>
      </Modal>
    </>
  )
}
