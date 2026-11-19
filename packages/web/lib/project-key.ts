export const PROJECT_KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/

/** "Customer Portal 2" -> "CP2": initials of the words (or the first letters of a single word), at most 10 characters. */
export function suggestKey(name: string): string {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)
  if (!words.length) return ''
  const raw = words.length === 1 ? words[0].slice(0, 4) : words.map((w) => w[0]).join('')
  return raw.replace(/^[0-9]+/, '').slice(0, 10)
}
