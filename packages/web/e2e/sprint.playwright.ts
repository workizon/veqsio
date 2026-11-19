import { test, expect } from '@playwright/test';

// Needs a Scrum board with a few backlog issues (the demo data has one). Not run in CI here.
test.describe('Sprint planning', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.fill('input[placeholder="Username"]', 'admin');
    await page.fill('input[placeholder="Password"]', 'admin123');
    await page.click('button:has-text("Sign In")');
    await expect(page).toHaveURL(/.*dashboard/);
  });

  test('backlog page shows the backlog section', async ({ page }) => {
    await page.goto('/backlog');
    await expect(page.getByRole('heading', { name: 'Backlog', level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Backlog' }).or(page.getByRole('heading', { name: 'Backlog', level: 3 }))).toBeVisible();
  });

  test('create, plan, start and complete a sprint', async ({ page }) => {
    await page.goto('/backlog');
    await page.getByRole('button', { name: 'Create sprint' }).first().click();
    await page.getByLabel('Sprint name').fill('E2E Sprint');
    await page.getByLabel('Sprint goal (optional)').fill('E2E goal');
    await page.getByRole('dialog').getByRole('button', { name: 'Create sprint' }).click();
    await expect(page.getByRole('heading', { name: 'E2E Sprint' })).toBeVisible();

    // Move the first backlog issue with the accessible menu
    await page.getByRole('button', { name: /^Move .* to…$/ }).last().click();
    await page.getByRole('menuitem', { name: /E2E Sprint/ }).click();
    await expect(page.getByText(/Moved 1 issue to E2E Sprint/)).toBeVisible();

    await page.getByRole('region', { name: 'E2E Sprint' }).getByRole('button', { name: 'Start sprint' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Start sprint' }).click();
    await expect(page.getByText('Active')).toBeVisible();

    await page.getByRole('button', { name: 'Complete sprint' }).first().click();
    await page.getByRole('dialog').getByRole('button', { name: 'Complete sprint' }).click();
    await expect(page.getByText(/E2E Sprint completed/)).toBeVisible();
  });
});
