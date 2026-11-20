'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Eye, EyeOff, Lock } from 'lucide-react'
import { toast } from './toast'

export function ResetPasswordForm() {
  const { tr } = useI18n();

  const router = useRouter()
  const searchParams = useSearchParams()
  const token = searchParams.get('token') || ''
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (password.length < 8) {
      setError(tr('Password must be at least 8 characters long'))
      return
    }
    if (password !== confirm) {
      setError(tr('Passwords do not match'))
      return
    }
    setLoading(true)
    try {
      const res = await fetch('/rest/auth/1/password-reset/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
        credentials: 'include',
      })
      if (res.ok) {
        toast(tr('Password updated. Please sign in.'), 'success')
        router.push('/login')
      } else {
        const data = await res.json().catch(() => ({}))
        setError(data.errorMessages?.[0] || tr('Could not reset password'))
      }
    } catch {
      setError(tr('Network error'))
    } finally {
      setLoading(false)
    }
  }

  if (!token) {
    return (
      <div className="w-full max-w-sm space-y-5 text-center">
        <h1 className="text-heading-1 text-[var(--text-primary)]">{tr('Invalid reset link')}</h1>
        <p className="text-body-sm text-[var(--text-secondary)]">
          {tr('This password reset link is missing or malformed.')} </p>
        <Link href="/forgot-password" className="text-[var(--brand-500)] hover:underline text-body-sm">
          {tr('Request a new link')} </Link>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-5">
      <div className="text-center mb-8">
        <div className="w-14 h-14 rounded-xl bg-[var(--brand-500)] flex items-center justify-center mx-auto mb-4">
          <span className="text-white font-bold text-2xl">P</span>
        </div>
        <h1 className="text-heading-1 text-[var(--text-primary)]">{tr('Choose a new password')}</h1>
        <p className="text-body-sm text-[var(--text-secondary)] mt-1">
          {tr('You will be signed out of all devices')} </p>
      </div>

      <div className="space-y-4">
        <div className="relative">
          <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-tertiary)]" />
          <input
            type={showPassword ? 'text' : 'password'}
            placeholder={tr('New password')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="veqsio-input w-full pl-10 pr-10"
            required
            minLength={8}
            autoComplete="new-password"
          />
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
            aria-label={showPassword ? tr('Hide password') : tr('Show password')}
          >
            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
        <div className="relative">
          <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-tertiary)]" />
          <input
            type={showPassword ? 'text' : 'password'}
            placeholder={tr('Confirm new password')}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="veqsio-input w-full pl-10"
            required
            minLength={8}
            autoComplete="new-password"
          />
        </div>
      </div>

      {error && (
        <p className="text-body-sm text-[var(--error)]" role="alert">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={loading}
        className="veqsio-btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-60"
      >
        {loading ? (
          <span className="inline-block w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
        ) : (
          tr('Reset password')
        )}
      </button>

      <div className="text-center text-body-sm">
        <Link href="/login" className="text-[var(--brand-500)] hover:underline">
          {tr('Back to sign in')} </Link>
      </div>
    </form>
  )
}
