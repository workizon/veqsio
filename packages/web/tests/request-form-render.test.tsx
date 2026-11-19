import { describe, test, expect } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { RequestFormFields } from '../components/request-form'
import { FormCanvas } from '../components/form-builder/canvas'
import { FieldProperties, Palette, TypeProperties } from '../components/form-builder/properties'
import { PALETTE, checkForm, newField } from '../lib/form-builder'
import type { FieldDef } from '../lib/request-form'

const render = (fields: FieldDef[], values: Record<string, unknown> = {}, errors: Record<string, string> = {}) =>
  renderToStaticMarkup(<RequestFormFields fields={fields} values={values} errors={errors} onChange={() => {}} />)

describe('shared request form renderer', () => {
  test('renders every field type with labels and help text', () => {
    const html = render([
      { key: 'a', label: 'Short', type: 'text', required: true, helpText: 'Help A', placeholder: 'ph' },
      { key: 'b', label: 'Para', type: 'textarea' },
      { key: 'c', label: 'Pick', type: 'select', options: ['x', 'y'] },
      { key: 'd', label: 'Many', type: 'multiselect', options: ['x', 'y'] },
      { key: 'e', label: 'Boxes', type: 'checkboxes', options: ['x', 'y'] },
      { key: 'f', label: 'Radios', type: 'radio', options: ['x', 'y'] },
      { key: 'g', label: 'Day', type: 'date' },
      { key: 'h', label: 'Moment', type: 'datetime' },
      { key: 'i', label: 'Count', type: 'number' },
      { key: 'j', label: 'Site', type: 'url' },
      { key: 'k', label: 'Mail', type: 'email' },
      { key: 'l', label: 'Person', type: 'user' },
      { key: 'm', label: 'Files', type: 'attachment' },
      { key: 'n', label: 'Header', type: 'section' },
      { key: 'o', label: 'Note', type: 'help', helpText: 'Static text' },
      { key: 'p', label: 'Old checkbox', type: 'checkbox' },
    ])
    for (const l of ['Short', 'Para', 'Pick', 'Many', 'Boxes', 'Radios', 'Day', 'Moment', 'Count', 'Site', 'Mail', 'Person', 'Files', 'Header', 'Old checkbox']) expect(html).toContain(l)
    expect(html).toContain('Help A')
    expect(html).toContain('Static text')
    expect(html).toContain('type="radio"')
    expect(html).toContain('type="datetime-local"')
    expect(html).toContain('type="file"')
    expect(html).toContain('<h3')
  })
  test('hides conditional fields until their condition holds, and never renders internal fields', () => {
    const fields: FieldDef[] = [
      { key: 'kind', label: 'Kind', type: 'select', options: ['hw', 'sw'] },
      { key: 'serial', label: 'Serial', type: 'text', visibleWhen: { field: 'kind', value: 'hw' } },
      { key: 'secret', label: 'Agent only', type: 'text', internal: true },
    ]
    expect(render(fields, { kind: 'sw' })).not.toContain('Serial')
    expect(render(fields, { kind: 'hw' })).toContain('Serial')
    expect(render(fields, { kind: 'hw' })).not.toContain('Agent only')
  })
  test('legacy field definitions render unchanged', () => {
    const html = render([{ key: 'device', label: 'Device', type: 'select', required: true, options: ['Laptop'] }, { key: 'u', label: 'Urgent', type: 'checkbox' }])
    expect(html).toContain('Device')
    expect(html).toContain('aria-required="true"')
    expect(html).toContain('<option value="Laptop">Laptop</option>')
  })
  test('shows validation errors accessibly', () => {
    const html = render([{ key: 'a', label: 'A', type: 'text' }], {}, { a: 'A is required' })
    expect(html).toContain('role="alert"')
    expect(html).toContain('aria-invalid="true"')
  })
})

describe('form builder panels render for every field type', () => {
  const noop = () => {}
  test('palette, canvas and properties', () => {
    expect(renderToStaticMarkup(<Palette onAdd={noop} />)).toContain('Short text')
    let fields: FieldDef[] = []
    for (const p of PALETTE) fields = [...fields, newField(p.type, fields)]
    fields[2] = { ...fields[2], visibleWhen: { field: fields[0].key, value: 'x' }, internal: true, mapping: { target: 'labels' } }
    const canvas = renderToStaticMarkup(<FormCanvas fields={fields} selected={1} problems={checkForm(fields)} onSelect={noop} onMove={noop} onDuplicate={noop} onRemove={noop} />)
    expect(canvas).toContain('Internal only')
    expect(canvas).toContain('Conditional')
    expect(canvas).toContain('Move Short text down')
    fields.forEach((_, i) => {
      const html = renderToStaticMarkup(
        <FieldProperties fields={fields} index={i} ctx={{ customFields: [{ id: 1, name: 'Dept', fieldType: 'string' }], priorities: [], issueTypes: [], components: [], organizations: [] }} onChange={noop} onRelabel={noop} onRekey={noop} />,
      )
      expect(html).toMatch(/Label|Heading/)
    })
  })
  test('type properties', () => {
    const html = renderToStaticMarkup(
      <TypeProperties
        draft={{ name: 'T', issueTypeId: 1, enabled: true, visibility: 'organizations', organizationIds: [2], sortOrder: 0 }}
        ctx={{ customFields: [], priorities: [], issueTypes: [{ id: 1, name: 'Task' }], components: [], organizations: [{ id: 2, name: 'Acme' }] }}
        groups={['General']} onChange={noop}
      />,
    )
    expect(html).toContain('Acme')
    expect(html).toContain('Status of new requests')
  })
})
