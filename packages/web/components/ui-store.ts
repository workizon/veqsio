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
