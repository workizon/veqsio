'use client'


import { LanguageSwitcher } from '@/components/language-switcher'
import { useI18n } from '@/hooks/use-i18n'
import { useState, useEffect, useMemo, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useRealtimeStatus } from '@/hooks/use-realtime'
import {
  Search,
  Bell,
  HelpCircle,
  User,
  LogOut,
  ChevronDown,
  Settings,
  Menu,
  Plus,
  Loader2,
  Inbox,
  Info,
} from 'lucide-react'
import { ThemeToggle } from './theme-toggle'
import { useUIStore } from './ui-store'
import { useInbox, useMarkInboxRead } from '@/hooks/use-inbox'
import { toast } from './toast'
import { CreateIssueDialog } from './create-issue-dialog'
import { TopNav, AdminMenu } from './top-nav'
import { BrandLockup } from './brand-logo'
import { signOut } from '@/lib/session'
import { useTerm } from '@/hooks/use-term'

/* ------------------------------------------------------------------ */
/* Search chip: opens the command palette (components/command-palette) */
/* ------------------------------------------------------------------ */

function SearchChip() {
  const { tr } = useI18n();

  const setSearchOpen = useUIStore((s) => s.setSearchOpen)
  const [mac, setMac] = useState(false)
  useEffect(() => { setMac(/mac|iphone|ipad/i.test(navigator.platform || '')) }, [])
  return (
    <button
      type="button"
      onClick={() => setSearchOpen(true)}
      aria-haspopup="dialog"
      aria-keyshortcuts="Control+K Meta+K"
      aria-label={tr('Search or jump to…')}
      className="relative flex items-center w-9 sm:w-full max-w-sm h-9 bg-[var(--surface-1)] border border-[var(--surface-3)] rounded-lg sm:pl-10 sm:pr-16 text-sm text-left text-[var(--text-tertiary)] transition-all hover:border-[var(--brand-300)] hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-200)]"
    >
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" aria-hidden="true" />
      <span className="hidden sm:inline truncate">{tr('Search or jump to…')}</span>
      <span className="absolute right-2 top-1/2 -translate-y-1/2 hidden sm:inline-flex" aria-hidden="true"><kbd className="veqsio-kbd">{mac ? '⌘' : 'Ctrl'} K</kbd></span>
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* NotificationBell                                                      */
/* ------------------------------------------------------------------ */

function NotificationBell() {
  const { tr } = useI18n();

  const router = useRouter()
  const [open, setOpen] = useState(false)
  const { data: inbox } = useInbox()
  const markRead = useMarkInboxRead()
  const notifications = inbox?.items ?? []
  const unreadCount = inbox?.unread ?? 0
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        className="veqsio-btn-ghost p-2 relative"
        title={tr('Notifications')}
        onClick={() => setOpen(!open)}
      >
        <Bell className="w-5 h-5" />
        {unreadCount > 0 && (
          <span className="absolute top-1 right-1 min-w-[16px] h-4 px-1 rounded-full bg-[var(--error)] text-white text-[10px] font-bold flex items-center justify-center">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="fixed left-3 right-3 top-16 sm:absolute sm:left-auto sm:right-0 sm:top-full sm:mt-2 sm:w-80 veqsio-modal-panel py-2 z-50">
            <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--surface-3)]">
              <h3 className="text-heading-3 text-[var(--text-primary)]">{tr('Notifications')}</h3>
              <button
                onClick={() => markRead.mutate(undefined)}
                className="text-caption text-[var(--brand-500)] hover:underline"
              >
                {tr('Mark all read')} </button>
            </div>
            <div className="max-h-[60vh] overflow-y-auto">
              {notifications.length === 0 ? (
                <div className="px-4 py-6 text-center text-body-sm text-[var(--text-secondary)]">
                  <Inbox className="w-8 h-8 mx-auto mb-2 text-[var(--text-tertiary)]" />
                  {tr('No notifications yet')} </div>
              ) : (
                notifications.map((n) => (
                  <div
                    key={n.id}
                    className={`px-4 py-3 border-b border-[var(--surface-3)] last:border-0 hover:bg-[var(--surface-1)] transition-colors cursor-pointer ${
                      !n.read ? 'bg-[var(--brand-50)]/30' : ''
                    }`}
                    onClick={() => {
                      if (!n.read) markRead.mutate([n.id])
                      setOpen(false)
                      if (n.link) router.push(n.link)
                    }}
                  >
                    <div className="flex items-start gap-2">
                      <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${!n.read ? 'bg-[var(--brand-500)]' : 'bg-transparent'}`} />
                      <div className="flex-1">
                        <p className="text-body-sm font-medium text-[var(--text-primary)]">{n.title}</p>
                        <p className="text-caption text-[var(--text-secondary)] line-clamp-2 break-words">{n.body}</p>
                        <p className="text-caption-sm text-[var(--text-tertiary)] mt-1">
                          {new Date(n.createdAt).toLocaleString()}
                        </p>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="px-4 py-2 border-t border-[var(--surface-3)]">
              <Link
                href="/settings"
                className="text-caption text-[var(--brand-500)] hover:underline"
                onClick={() => setOpen(false)}
              >
                {tr('Notification settings')} </Link>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* QuickCreateModal                                                    */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/* Header                                                              */
/* ------------------------------------------------------------------ */

export function Header({ onMenuToggle }: { onMenuToggle?: () => void }) {
  const { tr } = useI18n();

  const router = useRouter()
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const { createOpen, setCreateOpen } = useUIStore()
  const { t } = useTerm()
  const liveStatus = useRealtimeStatus()

  return (
    <header className="veqsio-header h-header fixed top-0 right-0 left-0 z-30 flex items-center gap-2 px-3 lg:px-4">
      <div className="flex items-center gap-1">
        {onMenuToggle && (
          <button
            onClick={onMenuToggle}
            className="min-[1440px]:hidden veqsio-btn-ghost p-2 -ml-1"
            title={tr('Menu')}
          >
            <Menu className="w-5 h-5" />
          </button>
        )}
        <Link href="/" className="flex items-center gap-2 pr-3 mr-1">
          <BrandLockup height={22} />
        </Link>
        <TopNav />
      </div>

      {/* Center - Search */}
      <div className="flex-1 flex justify-center min-w-0">
        <SearchChip />
      </div>

      {/* Right actions */}
      <div className="flex items-center gap-1 sm:gap-2 ml-2 flex-shrink-0">
        {(liveStatus === 'reconnecting' || liveStatus === 'disconnected') && (
          <span role="status" className="hidden md:inline text-xs rounded bg-[var(--surface-2)] text-[var(--warning)] px-2 py-1" title={tr('Live updates are paused; the page refreshes normally.')}>
            {liveStatus === 'reconnecting' ? tr('Reconnecting…') : tr('Offline')}
          </span>
        )}
        <button
          onClick={() => setCreateOpen(true)}
          aria-label={t('Create issue')}
          className="veqsio-btn-primary flex items-center gap-2 sm:px-3 px-2"
        >
          <Plus className="w-4 h-4" />
          <span className="hidden sm:inline">{tr('Create')}</span>
        </button>

        <button className="veqsio-btn-ghost p-2 hidden sm:flex" title={tr('Keyboard shortcuts (Ctrl+/)')} aria-label={tr('Keyboard shortcuts')} onClick={() => useUIStore.getState().setShortcutsOpen(true)}>
          <HelpCircle className="w-5 h-5" />
        </button>

        <NotificationBell />

        <AdminMenu />

        <div className="hidden sm:block">
          <ThemeToggle />
        </div>

        <div className="relative">
          <button
            onClick={() => setUserMenuOpen(!userMenuOpen)}
            aria-label={tr('Account menu')}
            aria-expanded={userMenuOpen}
            className="flex items-center gap-2 p-1 rounded-lg hover:bg-[var(--surface-2)] transition-colors"
          >
            <div className="w-8 h-8 rounded-full bg-[var(--brand-500)] flex items-center justify-center">
              <User className="w-4 h-4 text-white" />
            </div>
            <ChevronDown className="w-4 h-4 text-[var(--text-tertiary)] hidden sm:block" />
          </button>

          {userMenuOpen && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setUserMenuOpen(false)}
              />
              <div className="absolute right-0 top-full mt-2 w-56 veqsio-modal-panel py-2 z-50">
                <div className="px-4 py-3 border-b border-[var(--surface-3)]">
                  <p className="text-sm font-medium text-[var(--text-primary)]">
                    {tr('Administrator')} </p>
                  <p className="text-xs text-[var(--text-tertiary)]">
                    {tr('admin@veqsio.local')} </p>
                </div>
                <Link
                  href="/profile"
                  className="flex items-center gap-3 px-4 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] transition-colors"
                  onClick={() => setUserMenuOpen(false)}
                >
                  <User className="w-4 h-4" />
                  {tr('Profile')} </Link>
                <Link
                  href="/about"
                  className="flex items-center gap-3 px-4 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] transition-colors"
                  onClick={() => setUserMenuOpen(false)}
                >
                  <Info className="w-4 h-4" />
                  {tr('About and licence notices')} </Link>
                <Link
                  href="/settings"
                  className="flex items-center gap-3 px-4 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] transition-colors"
                  onClick={() => setUserMenuOpen(false)}
                >
                  <Settings className="w-4 h-4" />
                  {tr('Settings')} </Link>
                <div className="px-3 py-2"><LanguageSwitcher block /></div>
                <div className="border-t border-[var(--surface-3)] mt-1 pt-1">
                  <button onClick={() => void signOut(router)} className="flex items-center gap-3 px-4 py-2 text-sm text-[var(--error)] hover:bg-[var(--surface-2)] w-full transition-colors">
                    <LogOut className="w-4 h-4" />
                    {tr('Sign out')} </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <CreateIssueDialog isOpen={createOpen} onClose={() => setCreateOpen(false)} />
    </header>
  )
}
