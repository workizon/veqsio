/** Ends the session on the server and returns to the login page. Best effort: the cookie is cleared by the API. */
export async function signOut(router: { push: (href: string) => void }): Promise<void> {
  try {
    await fetch('/rest/auth/1/session', { method: 'DELETE', credentials: 'include' })
  } catch {
    // offline or server down: still leave the app
  }
  // what was kept for offline reading belongs to the person who signed out
  const { clearOfflineCache } = await import('./offline-cache')
  await clearOfflineCache()
  router.push('/login')
}
