'use client'

/** Horizontal progress bar with an accessible name; the percentage is also printed so colour is never the only signal. */
export function ProgressBar({ percent, label, color = 'var(--brand-500)', showText = true }: { percent: number; label: string; color?: string; showText?: boolean }) {
  const p = Math.min(100, Math.max(0, Math.round(percent)))
  return (
    <div className="flex items-center gap-2">
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={p} className="h-2 flex-1 rounded-full bg-[var(--surface-3)] overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${p}%`, background: color }} />
      </div>
      {showText && <span className="text-xs tabular-nums text-[var(--text-secondary)] w-9 text-right">{p}%</span>}
    </div>
  )
}
