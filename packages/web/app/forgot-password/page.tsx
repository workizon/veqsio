'use client'

import { ForgotPasswordForm } from '@/components/forgot-password-form'

export default function ForgotPasswordPage() {
  return (
    <div className="min-h-screen bg-[var(--surface-1)] flex items-center justify-center px-4">
      <div className="w-full max-w-md flex justify-center">
        <ForgotPasswordForm />
      </div>
    </div>
  )
}
