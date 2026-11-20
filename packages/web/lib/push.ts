import { trNow } from './tr'
/** Browser side of Web Push (needs HTTPS or localhost, a service worker and the Notification API). */
export const pushSupported = () =>
  typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

export function urlBase64ToUint8Array(b64: string): Uint8Array {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4)
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

async function registration() {
  return (await navigator.serviceWorker.getRegistration('/')) ?? (await navigator.serviceWorker.register('/sw.js', { scope: '/' }))
}

export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null
  return (await registration()).pushManager.getSubscription()
}

export async function enablePush(): Promise<void> {
  if (!pushSupported()) throw new Error(trNow('This browser does not support push notifications'))
  if ((await Notification.requestPermission()) !== 'granted') throw new Error(trNow('Notifications are blocked for this site in the browser settings'))
  const keyRes = await fetch('/rest/api/2/push/key', { credentials: 'include' })
  if (!keyRes.ok) throw new Error(trNow('Could not get the push key'))
  const { publicKey } = await keyRes.json()
  const reg = await registration()
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource }))
  const res = await fetch('/rest/api/2/push/subscription', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub.toJSON()) })
  if (!res.ok) throw new Error(trNow('Could not save the subscription'))
}

export async function disablePush(): Promise<void> {
  const sub = await currentPushSubscription()
  if (!sub) return
  await fetch('/rest/api/2/push/subscription', { method: 'DELETE', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) })
  await sub.unsubscribe()
}
