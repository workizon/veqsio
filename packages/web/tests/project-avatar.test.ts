import { describe, expect, test } from 'bun:test'
import { PROJECT_AVATAR_PRESETS, projectAvatarPresetUrl } from '../components/project-avatar'

describe('project avatar presets', () => {
  test('offers a unique, labelled gallery with safe embedded SVG images', () => {
    expect(PROJECT_AVATAR_PRESETS.length).toBeGreaterThanOrEqual(8)
    expect(new Set(PROJECT_AVATAR_PRESETS.map((p) => p.id)).size).toBe(PROJECT_AVATAR_PRESETS.length)
    for (const preset of PROJECT_AVATAR_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0)
      const url = projectAvatarPresetUrl(preset.id)
      expect(url).toStartWith('data:image/svg+xml,')
      expect(decodeURIComponent(url!)).toContain('<svg')
      expect(decodeURIComponent(url!)).not.toMatch(/<script|onload=|javascript:/i)
    }
  })

  test('rejects unknown preset ids', () => {
    expect(projectAvatarPresetUrl('not-a-preset')).toBeNull()
  })
})
