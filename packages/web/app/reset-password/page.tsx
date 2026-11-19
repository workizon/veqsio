'use client'

import { Suspense } from 'react'
import { ResetPasswordForm } from '@/components/reset-password-form'

export default function ResetPasswordPage() {
  return (
    <div className="min-h-screen bg-[var(--surface-1)] flex items-center justify-center px-4">
      <div className="w-full max-w-md flex justify-center">
        <Suspense fallback={null}>
          <ResetPasswordForm />
        </Suspense>
      </div>
    </div>
  )
}
