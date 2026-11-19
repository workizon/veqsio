'use client'

import { useEffect, useState } from 'react'
import { Save, Globe, Calendar, Clock, Type } from 'lucide-react'
import { toast } from './toast'
import { Spinner } from './spinner'
import { useSystemConfig, useUpdateSystemConfig } from '@/hooks/use-admin'

export function SystemGeneralConfig() {
  const { data, isLoading } = useSystemConfig()
  const update = useUpdateSystemConfig()

  const [siteName, setSiteName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [defaultLanguage, setDefaultLanguage] = useState('en')
  const [dateFormat, setDateFormat] = useState('YYYY-MM-DD')
  const [timezone, setTimezone] = useState('UTC')

  useEffect(() => {
    if (data) {
      setSiteName(data.siteName)
      setBaseUrl(data.baseUrl)
      setDefaultLanguage(data.defaultLanguage)
      setDateFormat(data.dateFormat)
      setTimezone(data.timezone)
    }
  }, [data])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    try {
      await update.mutateAsync({
        siteName,
        baseUrl,
        defaultLanguage,
        dateFormat,
        timezone,
      })
      toast('Configuration saved successfully', 'success')
    } catch (err: any) {
      toast(err.message || 'Failed to save configuration', 'error')
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
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="veqsio-card space-y-6">
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
            <Type className="w-4 h-4 text-[var(--text-tertiary)]" />
            Site Name
          </label>
          <input
            type="text"
            value={siteName}
            onChange={(e) => setSiteName(e.target.value)}
            required
            className="veqsio-input w-full"
          />
          <p className="text-caption text-[var(--text-tertiary)]">
            Displayed in the browser title and header.
          </p>
        </div>

        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
            <Globe className="w-4 h-4 text-[var(--text-tertiary)]" />
            Base URL
          </label>
          <input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            required
            className="veqsio-input w-full"
          />
          <p className="text-caption text-[var(--text-tertiary)]">
            The root URL where Veqsio is hosted.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
              <Type className="w-4 h-4 text-[var(--text-tertiary)]" />
              Default Language
            </label>
            <select
              value={defaultLanguage}
              onChange={(e) => setDefaultLanguage(e.target.value)}
              className="veqsio-input w-full"
            >
              <option value="en">English</option>
              <option value="de">German</option>
              <option value="fr">French</option>
              <option value="es">Spanish</option>
              <option value="lv">Latvian</option>
            </select>
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
              <Calendar className="w-4 h-4 text-[var(--text-tertiary)]" />
              Date Format
            </label>
            <select
              value={dateFormat}
              onChange={(e) => setDateFormat(e.target.value)}
              className="veqsio-input w-full"
            >
              <option value="YYYY-MM-DD">YYYY-MM-DD</option>
              <option value="DD/MM/YYYY">DD/MM/YYYY</option>
              <option value="MM/DD/YYYY">MM/DD/YYYY</option>
              <option value="DD.MM.YYYY">DD.MM.YYYY</option>
            </select>
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
              <Clock className="w-4 h-4 text-[var(--text-tertiary)]" />
              Timezone
            </label>
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="veqsio-input w-full"
            >
              <option value="UTC">UTC</option>
              <option value="Europe/Riga">Europe/Riga</option>
              <option value="Europe/Berlin">Europe/Berlin</option>
              <option value="Europe/London">Europe/London</option>
              <option value="America/New_York">America/New_York</option>
              <option value="America/Los_Angeles">America/Los_Angeles</option>
              <option value="Asia/Tokyo">Asia/Tokyo</option>
            </select>
          </div>
        </div>
      </div>

      <div className="flex justify-end">
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
          Save Configuration
        </button>
      </div>
    </form>
  )
}
