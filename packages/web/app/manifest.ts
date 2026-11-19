import type { MetadataRoute } from 'next'
import { fetchBranding } from '@/lib/branding-server'

export const dynamic = 'force-dynamic'

/** Web app manifest: lets the app be installed on a phone or desktop. The name follows the instance branding. */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const b = await fetchBranding()
  return {
    name: b.siteName,
    short_name: b.siteName.length > 12 ? b.siteName.slice(0, 12) : b.siteName,
    description: `${b.siteName}: issue tracking and service management`,
    start_url: '/overview',
    scope: '/',
    display: 'standalone',
    background_color: '#0A1322',
    theme_color: '#155EEF',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
