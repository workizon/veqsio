'use client'

import { useEffect, useLayoutEffect } from 'react'
import { moduleI18n } from '@veqsio/sdk'
import { useI18n } from '@/hooks/use-i18n'

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/** Publishes the current interface language and the host's dictionary to the modules (see @veqsio/sdk `moduleI18n`). */
export function ModuleI18nBridge() {
  const { locale, tr } = useI18n()
  useIsoLayoutEffect(() => { moduleI18n.setHost(locale, tr) }, [locale, tr])
  // The page language for screen readers, browser translation and hyphenation (the server cannot know the stored choice).
  useIsoLayoutEffect(() => { document.documentElement.lang = locale }, [locale])
  return null
}
