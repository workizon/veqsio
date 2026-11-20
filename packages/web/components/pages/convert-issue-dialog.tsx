'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Modal } from '@/components/modal'
import { toast } from '@/components/toast'
import { useProjects } from '@/hooks/use-project-admin'
import { useConvertToIssue } from '@/hooks/use-pages'

/** "Convert highlighted text to issue": creates an issue in a chosen project and links it from the page. */
export function ConvertToIssueDialog({ pageId, text, defaultProject, onClose }: { pageId: number; text: string | null; defaultProject: string | null; onClose: () => void }) {
  const { tr } = useI18n();

  const projects = useProjects()
  const convert = useConvertToIssue(pageId)
  const [project, setProject] = useState('')
  const [summary, setSummary] = useState('')
  const [body, setBody] = useState('')
  const [created, setCreated] = useState<string | null>(null)

  useEffect(() => {
    if (text === null) return
    setBody(text); setSummary(''); setCreated(null)
  }, [text])
  useEffect(() => {
    if (!project && projects.data?.length) setProject(defaultProject && projects.data.some((p) => p.key === defaultProject) ? defaultProject : projects.data[0].key)
  }, [projects.data, defaultProject, project])

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    convert.mutate({ projectKey: project, text: body, summary: summary.trim() || undefined }, {
      onSuccess: (r) => { setCreated(r.issue.key); toast(`Created ${r.issue.key}`, 'success') },
      onError: (err) => toast(err.message, 'error'),
    })
  }

  return (
    <Modal isOpen={text !== null} onClose={onClose} title={tr('Create issue from selection')}>
      {created ? (
        <div className="space-y-4">
          <p>{tr('Created')} <Link className="text-[var(--brand-500)] underline" href={`/issues/${created}`}>{created}</Link>{tr('. It is linked from this page.')}</p>
          <button type="button" className="veqsio-btn-primary" onClick={onClose}>{tr('Done')}</button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label htmlFor="cti-project" className="block text-sm font-medium mb-1">{tr('Project')}</label>
            <select id="cti-project" className="veqsio-input w-full" value={project} onChange={(e) => setProject(e.target.value)} required>
              {(projects.data ?? []).map((p) => <option key={p.key} value={p.key}>{p.name} ({p.key})</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="cti-summary" className="block text-sm font-medium mb-1">{tr('Summary')}</label>
            <input id="cti-summary" className="veqsio-input w-full" value={summary} maxLength={255} onChange={(e) => setSummary(e.target.value)} placeholder={tr('Defaults to the first line of the selection')} />
          </div>
          <div>
            <label htmlFor="cti-text" className="block text-sm font-medium mb-1">{tr('Description (the selected text)')}</label>
            <textarea id="cti-text" className="veqsio-input w-full" rows={5} value={body} maxLength={20000} onChange={(e) => setBody(e.target.value)} required />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" className="veqsio-btn-ghost" onClick={onClose}>{tr('Cancel')}</button>
            <button type="submit" className="veqsio-btn-primary" disabled={!project || !body.trim() || convert.isPending}>{tr('Create issue')}</button>
          </div>
        </form>
      )}
    </Modal>
  )
}
