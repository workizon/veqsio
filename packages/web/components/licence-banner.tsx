'use client'


import { useI18n } from '@/hooks/use-i18n'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { useLicenseStatus } from '@/hooks/use-license'
import { licenceNotice } from '@/lib/licence-notice'

function useIsSystemAdmin() {
  return useQuery({
    queryKey: ['is-system-admin'],
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async () => {
      const r = await fetch('/rest/api/2/mypermissions?permissions=SYSTEM_ADMIN', { credentials: 'include' })
      if (!r.ok) return false
      return !!(await r.json())?.permissions?.SYSTEM_ADMIN?.havePermission
    },
  })
}

/** Tells administrators (only) that the licence is about to expire, in grace or expired. */
export function LicenceBanner() {
  const { tr } = useI18n();

  const admin = useIsSystemAdmin().data === true
  const { data } = useLicenseStatus(admin)
  const n = admin ? licenceNotice(data) : null
  if (!n) return null
  return (
    <div role={n.level === 'critical' ? 'alert' : 'status'} className={`px-4 py-2 text-center text-sm font-medium ${n.level === 'critical' ? 'bg-red-100 text-red-900' : 'bg-amber-100 text-amber-900'}`}>
      {n.message} <Link href="/admin/license" className="underline">{tr('Licence')}</Link>
    </div>
  )
}
