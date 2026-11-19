import { create } from 'zustand'

export interface UIStore {
  searchOpen: boolean
  createOpen: boolean
  shortcutsOpen: boolean
  setSearchOpen: (open: boolean) => void
  setCreateOpen: (open: boolean) => void
  setShortcutsOpen: (open: boolean) => void
}

export const useUIStore = create<UIStore>((set) => ({
  searchOpen: false,
  createOpen: false,
  shortcutsOpen: false,
  setSearchOpen: (open) => set({ searchOpen: open }),
  setCreateOpen: (open) => set({ createOpen: open }),
  setShortcutsOpen: (open) => set({ shortcutsOpen: open }),
}))

export interface NotificationItem {
  id: string
  title: string
  body: string
  read: boolean
  timestamp: string
  link?: string
}

interface NotificationStore {
  notifications: NotificationItem[]
  markAllRead: () => void
  markRead: (id: string) => void
}

export const useNotificationStore = create<NotificationStore>((set) => ({
  notifications: [
    { id: '1', title: 'Issue assigned', body: 'PROJ-42 was assigned to you', read: false, timestamp: new Date().toISOString(), link: '/issues/PROJ-42' },
    { id: '2', title: 'Comment added', body: 'Alice commented on PROJ-7', read: false, timestamp: new Date().toISOString(), link: '/issues/PROJ-7' },
    { id: '3', title: 'Sprint started', body: 'Sprint 3 has begun', read: true, timestamp: new Date().toISOString() },
  ],
  markAllRead: () =>
    set((state) => ({
      notifications: state.notifications.map((n) => ({ ...n, read: true })),
    })),
  markRead: (id) =>
    set((state) => ({
      notifications: state.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)),
    })),
}))