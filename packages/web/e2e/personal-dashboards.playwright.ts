import { test, expect } from '@playwright/test'

test('personal dashboards follow the API envelope and save configurable widgets', async ({ page }) => {
  let created = false
  let name = ''
  let gadgets: any[] = []
  let failSave = false
  await page.route('**/rest/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === '/rest/api/2/dashboard') {
      if (request.method() === 'POST') {
        name = request.postDataJSON().name
        created = true
        return route.fulfill({ status: 201, json: { id: '42', name } })
      }
      return route.fulfill({ json: { dashboards: created ? [{ id: '42', name, owner: { id: 7 } }] : [], total: created ? 1 : 0, isLast: true } })
    }
    if (url.pathname === '/rest/api/2/dashboard/42') {
      if (request.method() === 'PUT') {
        if (failSave) return route.fulfill({ status: 500, json: { errorMessages: ['Save unavailable'] } })
        gadgets = request.postDataJSON().gadgets
        return route.fulfill({ json: {} })
      }
      return route.fulfill({ json: { id: '42', name, layout: '2-column', gadgets } })
    }
    if (url.pathname.endsWith('/search')) return route.fulfill({ json: { total: 0, issues: [] } })
    return route.fulfill({ json: [] })
  })
  await page.goto('/dashboard')
  await expect(page).toHaveURL(/\/dashboards$/)
  await expect(page.getByRole('heading', { name: 'My dashboards' })).toBeVisible()
  await page.getByRole('button', { name: 'Create dashboard', exact: true }).first().click()
  await page.getByLabel('Name', { exact: true }).fill('My daily focus')
  await page.getByRole('dialog').getByRole('button', { name: 'Create dashboard' }).click()
  await expect(page).toHaveURL(/\/dashboards\/42$/)
  await page.getByRole('button', { name: 'Add widget', exact: true }).first().click()
  await page.getByRole('dialog').getByRole('button', { name: /Assigned to Me/ }).click()
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('button', { name: 'Customize' })).toBeVisible()
  expect(gadgets).toHaveLength(1)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Assigned to Me' })).toBeVisible()
  await expect(page.getByTitle('Remove', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Customize' }).click()
  await page.getByTitle('Remove', { exact: true }).click()
  failSave = true
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Save unavailable', { exact: true })).toBeVisible()
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Assigned to Me' })).toBeVisible()
  await page.getByRole('link', { name: 'Back to my dashboards' }).click()
  await expect(page.getByRole('heading', { name: 'My daily focus' })).toBeVisible()
})

test('a failed dashboard list is not shown as an empty workspace', async ({ page }) => {
  await page.route('**/rest/**', route => route.fulfill({ status: 500, json: { errorMessages: ['Unavailable'] } }))
  await page.goto('/dashboards')
  await expect(page.getByRole('heading', { name: 'Unable to load your dashboards' })).toBeVisible({ timeout: 20000 })
  await expect(page.getByRole('heading', { name: 'Build your first dashboard' })).toHaveCount(0)
})
