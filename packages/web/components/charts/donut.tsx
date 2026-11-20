'use client'

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import { useI18n } from '@/hooks/use-i18n'
import { ChartTooltip, PALETTE } from './chart-kit'

export interface Slice { name: string; value: number }

/** Donut with the total in the middle and a value list that carries names, counts and shares (readable without colour). */
export function Donut({ data, label = 'Issues', height = 200 }: { data: Slice[]; label?: string; height?: number }) {
  const { tr } = useI18n()
  const total = data.reduce((a, d) => a + d.value, 0)
  return (
    <div className="flex flex-col sm:flex-row items-center gap-4">
      <div className="relative shrink-0" style={{ width: height, height }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} isAnimationActive={false} dataKey="value" nameKey="name" innerRadius="66%" outerRadius="96%" paddingAngle={data.length > 1 ? 3 : 0} cornerRadius={4} stroke="none" startAngle={90} endAngle={-270}>
              {data.map((d, i) => <Cell key={d.name} fill={PALETTE[i % PALETTE.length]} />)}
            </Pie>
            <Tooltip content={<ChartTooltip formatValue={(v) => `${v} (${total ? Math.round((Number(v) / total) * 100) : 0}%)`} />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[26px] leading-8 font-semibold tabular-nums text-[var(--text-primary)]">{total}</span>
          <span className="text-[12px] text-[var(--text-tertiary)]">{tr(label)}</span>
        </div>
      </div>
      <ul className="w-full min-w-0 flex-1 space-y-1.5">
        {data.map((d, i) => {
          const pct = total ? Math.round((d.value / total) * 100) : 0
          return (
            <li key={d.name} className="flex items-center gap-2 text-[12px]">
              <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: PALETTE[i % PALETTE.length] }} aria-hidden="true" />
              <span className="truncate text-[var(--text-secondary)]">{d.name}</span>
              <span className="ml-auto pl-2 font-semibold tabular-nums text-[var(--text-primary)]">{d.value}</span>
              <span className="w-9 text-right tabular-nums text-[var(--text-tertiary)]">{pct}%</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
