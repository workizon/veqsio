'use client'

import { useEffect } from 'react'

const API = /^\/rest\/(api|agile|servicedeskapi)\//
const PUBLIC_PAGES = /^\/(login|forgot-password|reset-password|p|portal|intake|about|api-docs)(\/|$)/

/**
 * When the session is gone (it expired, or the instance was reset) the pages would stay on screen without data.
 * Any 401 from the API of a signed-in page sends the visitor to the sign-in page instead; they come back to the page they were on.
 */
export function SessionGuard() {
  useEffect(() => {
    const original = window.fetch
    let redirecting = false
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const res = await original(...args)
      if (res.status === 401 && !redirecting) {
        const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].pathname : (args[0] as Request).url
        const path = url.startsWith('http') ? new URL(url).pathname : url.split('?')[0]
        const isLogin = path.startsWith('/rest/auth/')
        if (API.test(path) && !isLogin && !PUBLIC_PAGES.test(window.location.pathname)) {
          redirecting = true
          window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`)
        }
      }
      return res
    }
    return () => { window.fetch = original }
  }, [])
  return null
}
