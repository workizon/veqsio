'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Mail } from 'lucide-react'
import { toast } from './toast'

export function ForgotPasswordForm() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    try {
      const res = await fetch('/rest/auth/1/password-reset/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
        credentials: 'include',
      })
      if (res.ok) {
        setSubmitted(true)
      } else {
        toast('Something went wrong. Please try again.', 'error')
      }
    } catch {
      toast('Network error', 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="w-full max-w-sm space-y-5">
      <div className="text-center mb-8">
        <div className="w-14 h-14 rounded-xl bg-[var(--brand-500)] flex items-center justify-center mx-auto mb-4">
          <span className="text-white font-bold text-2xl">P</span>
        </div>
        <h1 className="text-heading-1 text-[var(--text-primary)]">Forgot your password?</h1>
        <p className="text-body-sm text-[var(--text-secondary)] mt-1">
          Enter your email and we will send you a link to reset it
        </p>
      </div>

      {submitted ? (
        <p className="text-body-sm text-[var(--text-secondary)] text-center" role="status">
          If an account with that email exists, a password reset link has been sent. The link expires in 1 hour.
        </p>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-tertiary)]" />
            <input
              type="email"
              placeholder="Email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="veqsio-input w-full pl-10"
              required
              autoComplete="email"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="veqsio-btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-60"
          >
            {loading ? (
              <span className="inline-block w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              'Send reset link'
            )}
          </button>
        </form>
      )}

      <div className="text-center text-body-sm">
        <Link href="/login" className="text-[var(--brand-500)] hover:underline">
          Back to sign in
        </Link>
      </div>
    </div>
  )
}
