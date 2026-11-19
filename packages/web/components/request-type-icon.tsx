import {
  HelpCircle, AlertTriangle, Package, Calendar, User, MessageSquare, Laptop, Wifi, ShieldCheck, KeyRound, CreditCard,
  Building2, Wrench, Truck, FileText, Mail, Phone, Heart, Star, Zap, type LucideIcon,
} from 'lucide-react'

/** Icons an admin can pick for a request type. The stored value is the key. */
export const REQUEST_TYPE_ICONS: Record<string, { Icon: LucideIcon; label: string }> = {
  'help-circle': { Icon: HelpCircle, label: 'Question' },
  'alert-triangle': { Icon: AlertTriangle, label: 'Problem' },
  package: { Icon: Package, label: 'Package' },
  calendar: { Icon: Calendar, label: 'Calendar' },
  user: { Icon: User, label: 'Person' },
  'message-square': { Icon: MessageSquare, label: 'Message' },
  laptop: { Icon: Laptop, label: 'Laptop' },
  wifi: { Icon: Wifi, label: 'Network' },
  'shield-check': { Icon: ShieldCheck, label: 'Security' },
  'key-round': { Icon: KeyRound, label: 'Access' },
  'credit-card': { Icon: CreditCard, label: 'Payment' },
  building: { Icon: Building2, label: 'Building' },
  wrench: { Icon: Wrench, label: 'Repair' },
  truck: { Icon: Truck, label: 'Delivery' },
  'file-text': { Icon: FileText, label: 'Document' },
  mail: { Icon: Mail, label: 'Email' },
  phone: { Icon: Phone, label: 'Phone' },
  heart: { Icon: Heart, label: 'Heart' },
  star: { Icon: Star, label: 'Star' },
  zap: { Icon: Zap, label: 'Quick' },
}

export function RequestTypeIcon({ name, className }: { name?: string | null; className?: string }) {
  const Icon = (name && REQUEST_TYPE_ICONS[name]?.Icon) || HelpCircle
  return <Icon className={className ?? 'w-5 h-5'} aria-hidden />
}

/** The icon on a soft brand-tinted tile, as shown on portal cards and the form header. */
export function RequestTypeTile({ name, size = 'md' }: { name?: string | null; size?: 'md' | 'lg' }) {
  const box = size === 'lg' ? 'w-12 h-12 rounded-xl' : 'w-10 h-10 rounded-lg'
  return (
    <span aria-hidden className={`${box} shrink-0 inline-flex items-center justify-center bg-[var(--brand-50)] text-[var(--brand-600)] ring-1 ring-inset ring-[var(--brand-100)]`}>
      <RequestTypeIcon name={name} className={size === 'lg' ? 'w-6 h-6' : 'w-5 h-5'} />
    </span>
  )
}
