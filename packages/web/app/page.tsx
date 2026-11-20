'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function HomePage() {
  const { tr } = useI18n();

  const router = useRouter()

  useEffect(() => {
    fetch('/rest/api/2/myself', { credentials: 'include' })
      .then((res) => {
        if (res.ok) {
          router.replace('/dashboard')
        } else {
          router.push('/login')
        }
      })
      .catch(() => router.push('/login'))
  }, [router])

  return (
    <div className="min-h-screen bg-[var(--surface-1)] flex items-center justify-center px-4">
      <div className="text-center">
        <h1 className="text-display text-[var(--text-primary)] mb-4">{tr('Veqsio')}</h1>
        <p className="text-body text-[var(--text-secondary)] mb-8">
          {tr('Loading...')} </p>
      </div>
    </div>
  )
}
