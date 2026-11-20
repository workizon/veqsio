'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import { useParams } from 'next/navigation'
import { Trash2 } from 'lucide-react'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import {
  useAddAgent, useAddCustomer, useDeleteOrg, useDeskAdmin, useDeskAgents, useDeskCustomers, useDeskOrgs, useMoveCustomer,
  useRemoveAgent, useRemoveCustomer, useSaveOrg,
} from '@/hooks/use-servicedesk-admin'
import { SortableTh } from '@/components/sortable-th'
import { useMultiSort } from '@/lib/table-sort'
import { confirmDialog } from '@/components/dialogs'

const onErr = (e: Error) => toast(e.message, 'error')

/** Project settings > Customers and organizations (plus agents and desk roles) */
export default function CustomersPage() {
  const { tr } = useI18n();

  const customerSort = useMultiSort()
  const agentSort = useMultiSort()
  const id = Number(useParams<{ id: string }>().id)
  const { isAdmin } = useDeskAdmin(id)
  const customers = useDeskCustomers(id)
  const orgs = useDeskOrgs(id)
  const agents = useDeskAgents(id)
  const addCustomer = useAddCustomer(id)
  const moveCustomer = useMoveCustomer(id)
  const removeCustomer = useRemoveCustomer(id)
  const saveOrg = useSaveOrg(id)
  const deleteOrg = useDeleteOrg(id)
  const addAgent = useAddAgent(id)
  const removeAgent = useRemoveAgent(id)

  const [email, setEmail] = useState('')
  const [org, setOrg] = useState('')
  const [orgName, setOrgName] = useState('')
  const [editingOrg, setEditingOrg] = useState<{ id: number; name: string } | null>(null)
  const [agentEmail, setAgentEmail] = useState('')
  const [agentRole, setAgentRole] = useState<'agent' | 'admin'>('agent')

  return (
    <div className="space-y-8">
      {/* customers */}
      <section className="space-y-3" aria-labelledby="cust-h">
        <h2 id="cust-h" className="text-heading-2">{tr('Customers')}</h2>
        <p className="text-sm text-[var(--text-secondary)]">{tr('People who can raise requests. They need an account; add them by the email address of that account.')}</p>
        {isAdmin && (
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => {
            e.preventDefault()
            addCustomer.mutate({ email: email.trim(), organizationId: org ? Number(org) : null }, { onSuccess: () => { setEmail(''); toast(tr('Customer added'), 'success') }, onError: onErr })
          }}>
            <label className="space-y-1"><span className="block text-sm font-medium">{tr('Email')}</span><input type="email" required className="veqsio-input w-64" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <label className="space-y-1"><span className="block text-sm font-medium">{tr('Organization')}</span>
              <select className="veqsio-input" value={org} onChange={(e) => setOrg(e.target.value)}>
                <option value="">{tr('None')}</option>{orgs.data?.values.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </label>
            <button type="submit" className="veqsio-btn-primary" disabled={addCustomer.isPending}>{tr('Add customer')}</button>
          </form>
        )}
        {customers.isLoading && <Spinner />}
        <div className="veqsio-card p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{tr('Customers')}</caption>
            <thead><tr className="veqsio-table-header text-left"><SortableTh {...customerSort.th('name')} className="px-3 py-2">{tr('Name')}</SortableTh><SortableTh {...customerSort.th('email')} className="px-3 py-2">{tr('Email')}</SortableTh><SortableTh {...customerSort.th('org')} className="px-3 py-2">{tr('Organization')}</SortableTh><th scope="col" className="px-3 py-2 w-12"><span className="sr-only">{tr('Actions')}</span></th></tr></thead>
            <tbody>
              {customers.data?.values.length === 0 && <tr><td colSpan={4} className="px-3 py-4 text-[var(--text-tertiary)]">{tr('No customers yet.')}</td></tr>}
              {customerSort.sort(customers.data?.values ?? [], { name: (c) => c.displayName, email: (c) => c.email, org: (c) => (c as any).organization?.name ?? (c as any).organization }).map((c) => (
                <tr key={c.userId} className="border-t border-[var(--surface-3)]">
                  <td className="px-3 py-2">{c.displayName}</td>
                  <td className="px-3 py-2 text-[var(--text-secondary)]">{c.email}</td>
                  <td className="px-3 py-2">
                    {isAdmin ? (
                      <select aria-label={`Organization of ${c.displayName}`} className="veqsio-input py-1" value={c.organizationId ?? ''} onChange={(e) => moveCustomer.mutate({ userId: c.userId, organizationId: e.target.value ? Number(e.target.value) : null }, { onError: onErr })}>
                        <option value="">{tr('None')}</option>{orgs.data?.values.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                      </select>
                    ) : (c.organization ?? 'None')}
                  </td>
                  <td className="px-3 py-2">{isAdmin && <button className="veqsio-btn-ghost p-1.5 text-[var(--error)]" aria-label={`Remove ${c.displayName}`} onClick={async () => { if ((await confirmDialog(`Remove ${c.displayName} from this service desk?`))) removeCustomer.mutate(c.userId, { onError: onErr }) }}><Trash2 className="w-4 h-4" /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* organizations */}
      <section className="space-y-3" aria-labelledby="org-h">
        <h2 id="org-h" className="text-heading-2">{tr('Organizations')}</h2>
        <p className="text-sm text-[var(--text-secondary)]">{tr('Group customers, for example by company. Request types can be limited to organizations.')}</p>
        {isAdmin && (
          <form className="flex items-end gap-2" onSubmit={(e) => {
            e.preventDefault()
            saveOrg.mutate({ name: orgName.trim() }, { onSuccess: () => { setOrgName(''); toast(tr('Organization created'), 'success') }, onError: onErr })
          }}>
            <label className="space-y-1"><span className="block text-sm font-medium">{tr('New organization')}</span><input required maxLength={255} className="veqsio-input w-64" value={orgName} onChange={(e) => setOrgName(e.target.value)} /></label>
            <button type="submit" className="veqsio-btn-primary" disabled={saveOrg.isPending}>{tr('Create')}</button>
          </form>
        )}
        <ul className="space-y-2">
          {orgs.data?.values.length === 0 && <li className="text-sm text-[var(--text-tertiary)]">{tr('No organizations yet.')}</li>}
          {orgs.data?.values.map((o) => (
            <li key={o.id} className="veqsio-card p-3 flex items-center gap-3">
              {editingOrg?.id === o.id ? (
                <form className="flex flex-1 gap-2" onSubmit={(e) => { e.preventDefault(); saveOrg.mutate({ orgId: o.id, name: editingOrg.name.trim() }, { onSuccess: () => setEditingOrg(null), onError: onErr }) }}>
                  <input aria-label={tr('Organization name')} autoFocus className="veqsio-input flex-1" value={editingOrg.name} onChange={(e) => setEditingOrg({ id: o.id, name: e.target.value })} />
                  <button className="veqsio-btn-primary" type="submit">{tr('Save')}</button>
                  <button className="veqsio-btn-secondary" type="button" onClick={() => setEditingOrg(null)}>{tr('Cancel')}</button>
                </form>
              ) : (
                <>
                  <span className="flex-1 font-medium">{o.name}</span>
                  <span className="text-xs text-[var(--text-tertiary)]">{o.customerCount} customer{o.customerCount === 1 ? '' : 's'}</span>
                  {isAdmin && (
                    <>
                      <button className="veqsio-btn-secondary text-sm" onClick={() => setEditingOrg({ id: o.id, name: o.name })}>{tr('Rename')}<span className="sr-only"> {o.name}</span></button>
                      <button className="veqsio-btn-ghost p-1.5 text-[var(--error)]" aria-label={`Delete ${o.name}`} onClick={async () => { if ((await confirmDialog(`Delete ${o.name}? Its customers stay, without an organization.`))) deleteOrg.mutate(o.id, { onError: onErr }) }}><Trash2 className="w-4 h-4" /></button>
                    </>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      </section>

      {/* agents */}
      <section className="space-y-3" aria-labelledby="agent-h">
        <h2 id="agent-h" className="text-heading-2">{tr('Agents and roles')}</h2>
        <p className="text-sm text-[var(--text-secondary)]">{tr('Administrators configure the service desk. Agents work on requests and see the configuration read-only. Project and Jira administrators are always administrators.')}</p>
        {isAdmin && (
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => {
            e.preventDefault()
            addAgent.mutate({ email: agentEmail.trim(), role: agentRole }, { onSuccess: () => { setAgentEmail(''); toast(tr('Agent saved'), 'success') }, onError: onErr })
          }}>
            <label className="space-y-1"><span className="block text-sm font-medium">{tr('Email')}</span><input type="email" required className="veqsio-input w-64" value={agentEmail} onChange={(e) => setAgentEmail(e.target.value)} /></label>
            <label className="space-y-1"><span className="block text-sm font-medium">{tr('Role')}</span>
              <select className="veqsio-input" value={agentRole} onChange={(e) => setAgentRole(e.target.value as 'agent' | 'admin')}><option value="agent">{tr('Agent')}</option><option value="admin">{tr('Administrator')}</option></select>
            </label>
            <button type="submit" className="veqsio-btn-primary" disabled={addAgent.isPending}>{tr('Add or update')}</button>
          </form>
        )}
        <div className="veqsio-card p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{tr('Agents')}</caption>
            <thead><tr className="veqsio-table-header text-left"><SortableTh {...agentSort.th('name')} className="px-3 py-2">{tr('Name')}</SortableTh><SortableTh {...agentSort.th('email')} className="px-3 py-2">{tr('Email')}</SortableTh><SortableTh {...agentSort.th('role')} className="px-3 py-2">{tr('Role')}</SortableTh><th scope="col" className="px-3 py-2 w-12"><span className="sr-only">{tr('Actions')}</span></th></tr></thead>
            <tbody>
              {agents.data?.values.length === 0 && <tr><td colSpan={4} className="px-3 py-4 text-[var(--text-tertiary)]">{tr('No agents added explicitly.')}</td></tr>}
              {agentSort.sort(agents.data?.values ?? [], { name: (a) => a.displayName, email: (a) => a.email, role: (a) => a.role }).map((a) => (
                <tr key={a.userId} className="border-t border-[var(--surface-3)]">
                  <td className="px-3 py-2">{a.displayName}</td>
                  <td className="px-3 py-2 text-[var(--text-secondary)]">{a.email}</td>
                  <td className="px-3 py-2">
                    {isAdmin ? (
                      <select aria-label={`Role of ${a.displayName}`} className="veqsio-input py-1" value={a.role} onChange={(e) => addAgent.mutate({ email: a.email, role: e.target.value as 'agent' | 'admin' }, { onError: onErr })}>
                        <option value="agent">{tr('Agent')}</option><option value="admin">{tr('Administrator')}</option>
                      </select>
                    ) : (a.role === 'admin' ? 'Administrator' : 'Agent')}
                  </td>
                  <td className="px-3 py-2">{isAdmin && <button className="veqsio-btn-ghost p-1.5 text-[var(--error)]" aria-label={`Remove ${a.displayName}`} onClick={async () => { if ((await confirmDialog(`Remove ${a.displayName} from this service desk?`))) removeAgent.mutate(a.userId, { onError: onErr }) }}><Trash2 className="w-4 h-4" /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
