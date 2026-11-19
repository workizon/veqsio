'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Eye, EyeOff, Lock, User } from 'lucide-react'
import { toast } from './toast'
import { BrandLogo } from './brand-logo'
import { useBranding } from '@/hooks/use-branding'
import { usePublicOidcProviders } from '@/hooks/use-oidc'
import { usePublicSamlProviders } from '@/hooks/use-saml'
import { ssoErrorMessage } from '@/lib/sso-forms'

export function LoginForm() {
  const router = useRouter()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [isDemo, setIsDemo] = useState(false)
  const { data: oidcProviders } = usePublicOidcProviders()
  const { data: samlProviders } = usePublicSamlProviders()
  const { siteName } = useBranding()

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('sso_error')
    if (code) toast(ssoErrorMessage(code), 'error')
    if (window.location.hostname === 'demo.veqsio.com') {
      setIsDemo(true)
      setUsername('admin')
      setPassword('demo12345')
    }
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)

    try {
      const res = await fetch('/rest/auth/1/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
        credentials: 'include',
      })

      if (res.ok) {
        toast('Welcome back!', 'success')
        const next = new URLSearchParams(window.location.search).get('next')
        router.push(next && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') && !/[\u0000-\u001f\u007f]/.test(next) ? next : '/dashboard')
      } else {
        const data = await res.json()
        toast(data.errorMessages?.[0] || 'Login failed', 'error')
      }
    } catch (err) {
      toast('Network error', 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-5">
      <div className="mb-8">
        <BrandLogo size={40} className="mb-6 lg:hidden" />
        <p className="text-caption text-[var(--text-tertiary)] mb-2">YOUR WORKSPACE, READY WHEN YOU ARE</p>
        <h1 className="text-3xl font-semibold tracking-tight text-[var(--text-primary)]">Welcome back</h1>
        <p className="text-body-sm text-[var(--text-secondary)] mt-1">
          Sign in to continue to {siteName}.
        </p>
      </div>

      {isDemo && (
        <div className="rounded-lg border border-[var(--surface-3)] bg-[var(--surface-1)] px-4 py-3 text-sm text-[var(--text-secondary)]">
          <p className="font-medium text-[var(--text-primary)] mb-1">Demo account</p>
          <p>Username: <code>admin</code></p>
          <p>Password: <code>demo12345</code></p>
        </div>
      )}

      <div className="space-y-4">
        <label htmlFor="username" className="block text-sm font-medium text-[var(--text-secondary)]">Username</label>
        <div className="relative">
          <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-tertiary)]" />
          <input
            type="text"
            id="username"
            autoComplete="username"
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="veqsio-input w-full pl-10 h-11"
            required
          />
        </div>

        <label htmlFor="password" className="block text-sm font-medium text-[var(--text-secondary)]">Password</label>
        <div className="relative">
          <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-tertiary)]" />
          <input
            type={showPassword ? 'text' : 'password'}
            id="password"
            autoComplete="current-password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="veqsio-input w-full pl-10 pr-12 h-11"
            required
          />
          <button
            type="button"
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            aria-pressed={showPassword}
            onClick={() => setShowPassword(!showPassword)}
            className="absolute right-1 top-1/2 -translate-y-1/2 p-3 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
          >
            {showPassword ? (
              <EyeOff className="w-4 h-4" />
            ) : (
              <Eye className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>

      {!isDemo && (
        <div className="text-right -mt-2">
          <Link href="/forgot-password" className="text-body-sm text-[var(--brand-500)] hover:underline">
            Forgot password?
          </Link>
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="veqsio-btn-primary w-full h-11 flex items-center justify-center gap-2 disabled:opacity-60"
      >
        {loading ? (
          <><span aria-hidden="true" className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Signing in…</>
        ) : (
          'Sign In'
        )}
      </button>

      {!isDemo && (
        <>
      <div className="relative my-6">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-[var(--surface-3)]" />
        </div>
        <div className="relative flex justify-center text-xs">
          <span className="px-2 bg-[var(--surface-0)] text-[var(--text-tertiary)]">
            or
          </span>
        </div>
      </div>

      <button
        type="button"
        onClick={() => { window.location.href = '/rest/auth/1/sso/microsoft' }}
        className="veqsio-btn-secondary w-full flex items-center justify-center gap-2"
      >
        <svg className="w-5 h-5" viewBox="0 0 24 24">
          <path fill="#0078D4" d="M0 0h11.5v11.5H0z"/>
          <path fill="#FFB900" d="M12.5 0H24v11.5H12.5z"/>
          <path fill="#00A4EF" d="M0 12.5h11.5V24H0z"/>
          <path fill="#F25022" d="M12.5 12.5H24V24H12.5z"/>
        </svg>
        Sign in with Microsoft
      </button>

      {oidcProviders?.map((p) => (
        <button
          key={p.slug}
          type="button"
          onClick={() => { window.location.href = `/rest/auth/1/oidc/${encodeURIComponent(p.slug)}/login` }}
          className="veqsio-btn-secondary w-full flex items-center justify-center gap-2"
        >
          <Lock className="w-4 h-4" />
          Sign in with {p.name}
        </button>
      ))}

      {samlProviders?.map((p) => (
        <button
          key={`saml-${p.slug}`}
          type="button"
          onClick={() => { window.location.href = `/rest/auth/1/saml/${encodeURIComponent(p.slug)}/login` }}
          className="veqsio-btn-secondary w-full flex items-center justify-center gap-2"
        >
          <Lock className="w-4 h-4" />
          Sign in with {p.name}
        </button>
      ))}
        </>
      )}
    </form>
  )
}
