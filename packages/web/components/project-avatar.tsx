/** Project picture: the uploaded image, or a tile with the key's initials on a colour derived from the key (like Jira's defaults). */
const PALETTE = ['#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#0d9488', '#0891b2', '#4f46e5']

export const PROJECT_AVATAR_PRESETS = [
  { id: 'orbit', label: 'Orbit', from: '#4338ca', to: '#06b6d4', shape: '<circle cx="34" cy="30" r="13" fill="none" stroke="white" stroke-width="5"/><ellipse cx="32" cy="32" rx="23" ry="9" fill="none" stroke="white" stroke-width="4" transform="rotate(-25 32 32)"/><circle cx="52" cy="22" r="4" fill="white"/>' },
  { id: 'summit', label: 'Summit', from: '#0f766e', to: '#34d399', shape: '<path d="M8 50 27 16l10 18 7-10 13 26H8Z" fill="white" opacity=".95"/><path d="m21 27 6-11 6 11-6-4-6 4Z" fill="#ccfbf1"/>' },
  { id: 'spark', label: 'Spark', from: '#c2410c', to: '#fbbf24', shape: '<path d="m35 7-5 18-15-6 10 14-16 8 20-1 1 18 8-17 17 7-11-15 13-10-18 4-4-20Z" fill="white"/>' },
  { id: 'prism', label: 'Prism', from: '#7e22ce', to: '#ec4899', shape: '<path d="M32 8 56 51H8L32 8Z" fill="white" opacity=".94"/><path d="m32 8 7 43H25l7-43Z" fill="#f5d0fe"/><path d="M8 51 32 35l24 16H8Z" fill="#fbcfe8" opacity=".8"/>' },
  { id: 'signal', label: 'Signal', from: '#1d4ed8', to: '#60a5fa', shape: '<circle cx="32" cy="43" r="5" fill="white"/><path d="M20 34a17 17 0 0 1 24 0M13 26a27 27 0 0 1 38 0" fill="none" stroke="white" stroke-width="5" stroke-linecap="round"/>' },
  { id: 'flow', label: 'Flow', from: '#0369a1', to: '#2dd4bf', shape: '<path d="M5 24c9-12 18-12 27 0s18 12 27 0v16c-9 12-18 12-27 0S14 28 5 40V24Z" fill="white" opacity=".92"/><circle cx="32" cy="32" r="6" fill="#0f766e"/>' },
  { id: 'launch', label: 'Launch', from: '#be123c', to: '#fb7185', shape: '<path d="M38 10c9 7 12 17 7 29L32 52 19 39c12-3 17-10 19-29Z" fill="white"/><circle cx="36" cy="25" r="5" fill="#fb7185"/><path d="m21 40-8 11 12-5m15 0 11-8-5 13" fill="none" stroke="white" stroke-width="4" stroke-linecap="round"/>' },
  { id: 'blocks', label: 'Blocks', from: '#374151', to: '#64748b', shape: '<rect x="9" y="10" width="21" height="21" rx="5" fill="white"/><rect x="34" y="10" width="21" height="21" rx="5" fill="white" opacity=".72"/><rect x="9" y="35" width="21" height="21" rx="5" fill="white" opacity=".72"/><rect x="34" y="35" width="21" height="21" rx="5" fill="white"/>' },
] as const

export function projectAvatarPresetUrl(id: string): string | null {
  const preset = PROJECT_AVATAR_PRESETS.find((item) => item.id === id)
  if (!preset) return null
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${preset.from}"/><stop offset="1" stop-color="${preset.to}"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="url(#g)"/>${preset.shape}</svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

export function projectColor(key: string): string {
  let h = 0
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}

export function ProjectAvatar({ projectKey, name, src, size = 24 }: { projectKey: string; name?: string; src?: string | null; size?: number }) {
  const style = { width: size, height: size }
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" style={style} className="shrink-0 rounded object-cover" />
  }
  return (
    <span
      aria-hidden="true"
      title={name}
      style={{ ...style, backgroundColor: projectColor(projectKey), fontSize: Math.max(Math.round(size * 0.4), 9) }}
      className="inline-flex shrink-0 select-none items-center justify-center rounded font-bold text-white"
    >
      {projectKey.slice(0, 2).toUpperCase()}
    </span>
  )
}
