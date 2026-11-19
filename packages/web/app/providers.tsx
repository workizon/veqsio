'use client'

import { DialogHost } from '@/components/dialogs'
import { SessionGuard } from '@/components/session-guard'
import { TableResizer } from '@/components/table-resizer'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { useState } from 'react'
import { AccentStyle } from '@/components/accent-style'
import { ToastContainer } from '@/components/toast'
import { BRANDING_KEY } from '@/hooks/use-branding'
import type { Branding } from '@/lib/branding'
import { PwaRegister } from '@/components/pwa-register'
import { KeyboardShortcuts } from '@/components/keyboard-shortcuts'

export function Providers({ children, branding }: { children: React.ReactNode; branding?: Branding }) {
  const [queryClient] = useState(() => {
    const qc = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 60 * 1000,
          refetchOnWindowFocus: false,
        },
      },
    })
    // The server already read the branding: no flash of the default logo and name.
    if (branding) qc.setQueryData(BRANDING_KEY, branding)
    return qc
  })

  return (
    <QueryClientProvider client={queryClient}>
      <AccentStyle />
      <PwaRegister />
      {children}
      <ToastContainer />
      <TableResizer />
      <SessionGuard />
      <DialogHost />
      <KeyboardShortcuts />
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  )
}
