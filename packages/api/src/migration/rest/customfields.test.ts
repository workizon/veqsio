import { describe, it, expect } from 'bun:test'
import { extractStoryPoints, isStoryPointsField, mapFieldType, storyPointFieldIds } from './customfields'

const f = (id: string, name: string, custom?: string) => ({ id, name, custom: true, schema: { type: 'number', custom } })

describe('story point detection', () => {
  it('detects by name or schema', () => {
    expect(isStoryPointsField(f('customfield_1', 'Story Points'))).toBe(true)
    expect(isStoryPointsField(f('customfield_2', 'Story point estimate'))).toBe(true)
    expect(isStoryPointsField(f('customfield_3', 'Size', 'com.atlassian.jira.plugin.system.customfieldtypes:jsw-story-points'))).toBe(true)
    expect(isStoryPointsField(f('customfield_4', 'Effort'))).toBe(false)
    expect(isStoryPointsField({ id: 'summary', name: 'Story Points' })).toBe(false)
  })

  it('is not migrated as a generic custom field', () => {
    expect(mapFieldType(f('customfield_1', 'Story Points'))).toBeNull()
    expect(mapFieldType(f('customfield_4', 'Effort'))).toBe('number')
  })

  it('collects ids and extracts a bounded value', () => {
    const metas = [f('customfield_1', 'Story Points'), f('customfield_2', 'Story point estimate'), f('customfield_4', 'Effort')]
    const ids = storyPointFieldIds(metas)
    expect(ids).toEqual(['customfield_1', 'customfield_2'])
    expect(extractStoryPoints({ customfield_1: 8 }, ids)).toBe(8)
    expect(extractStoryPoints({ customfield_1: null, customfield_2: 2.567 }, ids)).toBe(2.57)
    expect(extractStoryPoints({ customfield_1: '3,5' }, ids)).toBe(3.5)
    expect(extractStoryPoints({ customfield_1: -1 }, ids)).toBeNull()
    expect(extractStoryPoints({ customfield_1: 5000 }, ids)).toBeNull()
    expect(extractStoryPoints({ customfield_1: 'abc' }, ids)).toBeNull()
    expect(extractStoryPoints(undefined, ids)).toBeNull()
  })
})
