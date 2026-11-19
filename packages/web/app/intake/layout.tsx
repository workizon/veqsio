import type { Metadata } from 'next'

// Intake forms are addressed by a private link: keep them out of search results.
export const metadata: Metadata = { title: 'Submit a request', robots: { index: false, follow: false } }

export default function IntakeLayout({ children }: { children: React.ReactNode }) {
  return children
}
