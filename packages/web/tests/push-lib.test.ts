import { expect, it } from 'bun:test'
import { urlBase64ToUint8Array } from '../lib/push'

it('decodes a url-safe base64 VAPID key', () => {
  const bytes = urlBase64ToUint8Array('AQID_-4')
  expect([...bytes]).toEqual([1, 2, 3, 255, 238])
})
