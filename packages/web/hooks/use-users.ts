import { useQuery } from '@tanstack/react-query'

export interface UserSearchResult {
  id: number
  username: string
  displayName: string
  email: string
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export function useUsers() {
  return useQuery<UserSearchResult[]>({
    queryKey: ['users'],
    queryFn: async () => {
      const data = await fetchJson<{ id: number; key: string; name: string; emailAddress: string }[]>('/rest/api/2/user/search?query=')
      return data.map((u) => ({
        id: u.id,
        username: u.key,
        displayName: u.name,
        email: u.emailAddress,
      }))
    },
  })
}
