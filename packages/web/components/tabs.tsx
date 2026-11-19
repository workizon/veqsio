'use client'

import { useState } from 'react'

interface Tab {
  id: string
  label: string
  content?: React.ReactNode
  icon?: React.ReactNode
}

interface TabsProps {
  tabs: Tab[]
  defaultTab?: string
  activeTab?: string
  onChange?: (tabId: string) => void
  /** The tab strip is shown elsewhere (for example a side menu); only the content renders. */
  hideNav?: boolean
}

export function Tabs({ tabs, defaultTab, activeTab, onChange, hideNav }: TabsProps) {
  const [internalActive, setInternalActive] = useState(defaultTab || tabs[0]?.id)
  const active = activeTab ?? internalActive

  const handleClick = (tabId: string) => {
    if (onChange) {
      onChange(tabId)
    } else {
      setInternalActive(tabId)
    }
  }

  const activeTabObj = tabs.find((t) => t.id === active)

  return (
    <div className="space-y-4">
      {!hideNav && <div className="flex items-center gap-1 border-b border-[var(--surface-3)] overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => handleClick(tab.id)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors relative ${
              active === tab.id
                ? 'text-[var(--brand-500)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            {tab.icon}
            {tab.label}
            {active === tab.id && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--brand-500)] rounded-t-full" />
            )}
          </button>
        ))}
      </div>}
      {activeTabObj?.content !== undefined && <div>{activeTabObj.content}</div>}
    </div>
  )
}
