import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import { ThemeProvider } from '@/components/theme-provider'
import { Providers } from './providers'
import './globals.css'
import { fetchBranding } from '@/lib/branding-server'
import { accentCss } from '@/lib/branding'

export const dynamic = 'force-dynamic'

const geistSans = Geist({
  subsets: ['latin'],
  variable: '--font-geist-sans',
  display: 'swap',
})

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
  display: 'swap',
})

export const viewport: Viewport = { themeColor: '#155EEF', width: 'device-width', initialScale: 1 }

export async function generateMetadata(): Promise<Metadata> {
  const b = await fetchBranding()
  return {
    title: { default: b.siteName, template: `%s · ${b.siteName}` },
    description: `${b.siteName}: issue tracking and service management`,
    ...(b.faviconUrl ? { icons: { icon: b.faviconUrl, apple: '/icons/apple-touch-icon.png' } } : { icons: { apple: '/icons/apple-touch-icon.png' } }),
    appleWebApp: { capable: true, title: b.siteName, statusBarStyle: 'black-translucent' },
  }
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const branding = await fetchBranding()
  const css = accentCss(branding.accentColor)
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Built only from a validated #rrggbb colour (see lib/branding.ts), so it cannot carry markup. */}
        {css ? <style id="veqsio-accent" dangerouslySetInnerHTML={{ __html: css }} /> : null}
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased`}>
        <ThemeProvider>
          <Providers branding={branding}>
            {children}
          </Providers>
        </ThemeProvider>
      </body>
    </html>
  )
}
