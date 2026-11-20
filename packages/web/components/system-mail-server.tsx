'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useState } from 'react'
import { Mail, Save, TestTube, Shield, Server, Eye, EyeOff } from 'lucide-react'
import { toast } from './toast'
import { Spinner } from './spinner'
import { useMailConfig, useUpdateMailConfig, useTestMailConfig } from '@/hooks/use-admin'

export function SystemMailServer() {
  const { tr } = useI18n();

  const { data, isLoading } = useMailConfig()
  const update = useUpdateMailConfig()
  const test = useTestMailConfig()

  const [host, setHost] = useState('')
  const [port, setPort] = useState(587)
  const [user, setUser] = useState('')
  const [pass, setPass] = useState('')
  const [from, setFrom] = useState('')
  const [tls, setTls] = useState(true)
  const [showPass, setShowPass] = useState(false)
  const [testAddress, setTestAddress] = useState('')

  useEffect(() => {
    if (data) {
      setHost(data.host)
      setPort(data.port)
      setUser(data.user)
      setPass(data.pass)
      setFrom(data.from)
      setTls(data.tls)
    }
  }, [data])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    try {
      await update.mutateAsync({ host, port, user, pass, from, tls })
      toast(tr('Mail server configuration saved'), 'success')
    } catch (err: any) {
      toast(err.message || 'Failed to save mail configuration', 'error')
    }
  }

  async function handleTest() {
    if (!testAddress) {
      toast(tr('Please enter a test email address'), 'warning')
      return
    }
    try {
      const res = await test.mutateAsync({ to: testAddress })
      toast(res.message, 'success')
    } catch (err: any) {
      toast(err.message || 'Failed to send test email', 'error')
    }
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <form onSubmit={handleSave} className="veqsio-card space-y-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-[var(--surface-2)] flex items-center justify-center">
            <Mail className="w-5 h-5 text-[var(--brand-500)]" />
          </div>
          <div>
            <h2 className="text-heading-2 text-[var(--text-primary)]">{tr('Outgoing mail')}</h2>
            <p className="text-body-sm text-[var(--text-secondary)]">
              {tr('Configure the SMTP server used for notifications.')} </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
              <Server className="w-4 h-4 text-[var(--text-tertiary)]" />
              {tr('SMTP Host')} </label>
            <input
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="smtp.example.com"
              required
              className="veqsio-input w-full"
            />
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
              <Server className="w-4 h-4 text-[var(--text-tertiary)]" />
              {tr('SMTP Port')} </label>
            <input
              type="number"
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
              required
              className="veqsio-input w-full"
            />
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
              <Mail className="w-4 h-4 text-[var(--text-tertiary)]" />
              {tr('Username')} </label>
            <input
              type="text"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              className="veqsio-input w-full"
            />
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
              <Shield className="w-4 h-4 text-[var(--text-tertiary)]" />
              {tr('Password')} </label>
            <div className="relative">
              <input
                type={showPass ? 'text' : 'password'}
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                className="veqsio-input w-full pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPass(!showPass)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
              >
                {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div className="space-y-2 md:col-span-2">
            <label className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
              <Mail className="w-4 h-4 text-[var(--text-tertiary)]" />
              {tr('From Address')} </label>
            <input
              type="email"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              placeholder={tr('veqsio@example.com')}
              required
              className="veqsio-input w-full"
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <input
            id="tls"
            type="checkbox"
            checked={tls}
            onChange={(e) => setTls(e.target.checked)}
            className="w-4 h-4 rounded border-[var(--surface-4)] text-[var(--brand-500)]"
          />
          <label htmlFor="tls" className="text-sm text-[var(--text-secondary)]">
            {tr('Use TLS/SSL encryption')} </label>
        </div>

        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pt-4 border-t border-[var(--surface-3)]">
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <input
              type="email"
              value={testAddress}
              onChange={(e) => setTestAddress(e.target.value)}
              placeholder={tr('Test email address')}
              className="veqsio-input flex-1 sm:w-64"
            />
            <button
              type="button"
              onClick={handleTest}
              disabled={test.isPending}
              className="veqsio-btn-secondary flex items-center gap-2 disabled:opacity-60"
            >
              {test.isPending ? (
                <span className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
              ) : (
                <TestTube className="w-4 h-4" />
              )}
              {tr('Test')} </button>
          </div>

          <button
            type="submit"
            disabled={update.isPending}
            className="veqsio-btn-primary flex items-center gap-2 disabled:opacity-60"
          >
            {update.isPending ? (
              <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            {tr('Save')} </button>
        </div>
      </form>
    </div>
  )
}
