'use client'

import { useState, useRef, useEffect } from 'react'
import { ChevronDown, Check } from 'lucide-react'

interface SelectOption {
  value: string
  label: string
  icon?: React.ReactNode
}

interface SelectProps {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  size?: 'sm' | 'md'
}

export function Select({ value, options, onChange, placeholder = 'Select...', disabled, size = 'md' }: SelectProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const selected = options.find((o) => o.value === value)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const sizeClasses = {
    sm: 'py-1.5 px-2.5 text-xs',
    md: 'py-2 px-3 text-sm',
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => !disabled && setOpen(!open)}
        className={`w-full flex items-center justify-between gap-2 bg-[var(--surface-0)] border border-[var(--surface-4)] rounded-md ${sizeClasses[size]} text-[var(--text-primary)] hover:border-[var(--surface-3)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed`}
        disabled={disabled}
      >
        <div className="flex items-center gap-2">
          {selected?.icon}
          <span>{selected?.label || placeholder}</span>
        </div>
        <ChevronDown className={`w-4 h-4 text-[var(--text-tertiary)] transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute z-50 w-full mt-1 bg-[var(--surface-0)] border border-[var(--surface-3)] rounded-lg shadow-lg py-1">
          {options.map((option) => (
            <button
              key={option.value}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors ${
                value === option.value
                  ? 'bg-[var(--brand-50)] text-[var(--brand-600)]'
                  : 'text-[var(--text-primary)] hover:bg-[var(--surface-2)]'
              }`}
            >
              {option.icon}
              <span>{option.label}</span>
              {value === option.value && (
                <Check className="w-4 h-4 ml-auto" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
