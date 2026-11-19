import { CREDIT_TEXT } from '@/lib/branding'

/** "Powered by VEQSIO", linked to the product site. */
export function PoweredBy({ className = '' }: { className?: string }) {
  return <a href="https://veqsio.com" target="_blank" rel="noopener noreferrer" className={`hover:text-[var(--text-primary)] hover:underline underline-offset-2 ${className}`}>{CREDIT_TEXT}</a>
}
