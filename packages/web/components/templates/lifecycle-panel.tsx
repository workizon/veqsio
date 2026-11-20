'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { toast } from '@/components/toast'
import { useArchiveProject } from '@/hooks/use-templates'
import { useTerm } from '@/hooks/use-term'
import { confirmDialog } from '@/components/dialogs'

export const DELETE_PHRASE = 'delete this project'

/** Pure: may the delete button be enabled? Both the key and the phrase must be typed exactly. */
export function deleteConfirmed(projectKey: string, typedKey: string, typedPhrase: string): boolean {
  return typedKey === projectKey && typedPhrase === DELETE_PHRASE
}

/** Project settings, tab "Lifecycle": archive, restore and (for archived projects) delete. */
export function LifecyclePanel({ projectKey, projectName, archived }: { projectKey: string; projectName: string; archived: boolean }) {
  const { tr } = useI18n();

  const router = useRouter()
  const { issues } = useTerm()
  const { archive, restore, remove } = useArchiveProject(projectKey)
  const [typedKey, setTypedKey] = useState('')
  const [typedPhrase, setTypedPhrase] = useState('')
  const fail = (e: Error) => toast(e.message, 'error')
  const box = 'rounded-lg border bg-[var(--surface-0)] p-5 space-y-3'

  return (
    <div className="max-w-xl space-y-6">
      <section aria-labelledby="archive-heading" className={`${box} border-[var(--surface-3)]`}>
        <h2 id="archive-heading" className="text-heading-3">{archived ? 'This project is archived' : 'Archive project'}</h2>
        <p className="text-body-sm text-[var(--text-secondary)]">
          {archived
            ? `${projectName} is read-only: its ${issues} can be viewed but nothing can be created or changed, and recurring issues are paused. It is hidden from project lists and default searches. Restore it to continue working.`
            : `Archiving makes ${projectName} read-only and hides it from project lists, pickers and default searches. Its ${issues} stay reachable by link and by searching for the project key. You can restore it at any time.`}
        </p>
        {archived ? (
          <button className="veqsio-btn-primary" disabled={restore.isPending} onClick={() => restore.mutate(undefined, { onSuccess: () => toast(tr('Project restored'), 'success'), onError: fail })}>
            {restore.isPending && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}{tr('Restore project')} </button>
        ) : (
          <button className="veqsio-btn-secondary" disabled={archive.isPending} onClick={async () => { if ((await confirmDialog(`Archive ${projectName}? It becomes read-only.`))) archive.mutate(undefined, { onSuccess: () => toast(tr('Project archived'), 'success'), onError: fail }) }}>
            {archive.isPending && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}{tr('Archive project')} </button>
        )}
      </section>

      <section aria-labelledby="delete-heading" className={`${box} border-[var(--error)]`}>
        <h2 id="delete-heading" className="text-heading-3 text-[var(--error)]">{tr('Delete project')}</h2>
        {!archived ? (
          <p className="text-body-sm text-[var(--text-secondary)]">{tr('Only archived projects can be deleted. Archive the project first: it stops all changes and gives you time to restore it if that was a mistake.')}</p>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              if (!deleteConfirmed(projectKey, typedKey, typedPhrase)) return
              remove.mutate({ confirmKey: typedKey, confirmPhrase: typedPhrase }, { onSuccess: () => { toast(tr('Project deleted'), 'success'); router.push('/projects') }, onError: fail })
            }}
          >
            <p className="text-body-sm text-[var(--text-secondary)]">
              {tr('Permanently deletes')} {projectName} {tr('with all its')} {issues}{tr(', comments, boards and settings. This cannot be undone. Deleting needs the Administer permission.')} </p>
            <div>
              <label htmlFor="del-key" className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">{tr('Type the project key')} <code className="font-mono">{projectKey}</code></label>
              <input id="del-key" className="veqsio-input w-40 font-mono" value={typedKey} onChange={(e) => setTypedKey(e.target.value)} autoComplete="off" />
            </div>
            <div>
              <label htmlFor="del-phrase" className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">{tr('Type')} <code className="font-mono">{DELETE_PHRASE}</code></label>
              <input id="del-phrase" className="veqsio-input w-full" value={typedPhrase} onChange={(e) => setTypedPhrase(e.target.value)} autoComplete="off" />
            </div>
            <button type="submit" disabled={remove.isPending || !deleteConfirmed(projectKey, typedKey, typedPhrase)} className="veqsio-btn-primary !bg-[var(--error)] disabled:opacity-50">
              {remove.isPending && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}{tr('Delete project permanently')} </button>
          </form>
        )}
      </section>
    </div>
  )
}
