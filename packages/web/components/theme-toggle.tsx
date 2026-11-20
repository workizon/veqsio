'use client'


import { useI18n } from '@/hooks/use-i18n'
import { Sun, Moon } from 'lucide-react'
import { useTheme } from './theme-provider'

export function ThemeToggle() {
  const { tr } = useI18n();

  const { theme, toggleTheme } = useTheme()

  return (
    <button
      onClick={toggleTheme}
      className="veqsio-btn-ghost p-2"
      title={theme === 'light' ? tr('Switch to dark mode') : tr('Switch to light mode')}
    >
      {theme === 'light' ? (
        <Moon className="w-5 h-5" />
      ) : (
        <Sun className="w-5 h-5" />
      )}
    </button>
  )
}
