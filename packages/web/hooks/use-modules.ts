import { useQuery } from '@tanstack/react-query'
import type { ActiveModuleWeb } from '@/lib/module-registry'

/** Modules that are enabled and licensed on this instance, with their web contributions. */
export function useActiveModules() {
  return useQuery({
    queryKey: ['modules', 'active'],
    queryFn: async () => {
      const res = await fetch('/rest/api/2/modules/active', { credentials: 'include' })
      if (!res.ok) throw new Error(res.statusText)
      return ((await res.json()) as { modules: ActiveModuleWeb[] }).modules
    },
    staleTime: 60_000,
  })
}
