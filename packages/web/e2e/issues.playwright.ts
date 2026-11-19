import { test, expect } from '@playwright/test';

test.describe('Issues', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.fill('input[placeholder="Username"]', 'admin');
    await page.fill('input[placeholder="Password"]', 'admin123');
    await page.click('button:has-text("Sign In")');
    await expect(page).toHaveURL(/.*dashboard/);
  });

  test('create issue navigates to issue detail', async ({ page }) => {
    await page.goto('/issues/create');
    await expect(page.locator('text=Create issue')).toBeVisible();

    await page.selectOption('select:has-text("Select project")', { label: /Test Project/ });
    await page.fill('input[placeholder="What needs to be done?"]', 'E2E test issue');
    await page.click('button:has-text("Create issue")');

    await expect(page).toHaveURL(/.*issues\/TEST/);
    await expect(page.locator('text=E2E test issue')).toBeVisible();
  });

  test('edit issue summary', async ({ page }) => {
    await page.goto('/issues/create');
    await page.selectOption('select:has-text("Select project")', { label: /Test Project/ });
    await page.fill('input[placeholder="What needs to be done?"]', 'Edit me');
    await page.click('button:has-text("Create issue")');
    await expect(page).toHaveURL(/.*issues\/TEST/);

    await page.click('button:has-text("Edit")');
    await page.fill('input[value="Edit me"]', 'Edited summary');
    await page.click('button:has-text("Save")');

    await expect(page.locator('text=Edited summary')).toBeVisible();
  });

  test('add comment to issue', async ({ page }) => {
    await page.goto('/issues/create');
    await page.selectOption('select:has-text("Select project")', { label: /Test Project/ });
    await page.fill('input[placeholder="What needs to be done?"]', 'Comment test');
    await page.click('button:has-text("Create issue")');
    await expect(page).toHaveURL(/.*issues\/TEST/);

    await page.click('text=Comments');
    await page.fill('textarea[placeholder="Add a comment..."]', 'Great work!');
    await page.click('button:has-text("Add Comment")');

    await expect(page.locator('text=Great work!')).toBeVisible();
  });

  test('delete issue redirects to issues list', async ({ page }) => {
    await page.goto('/issues/create');
    await page.selectOption('select:has-text("Select project")', { label: /Test Project/ });
    await page.fill('input[placeholder="What needs to be done?"]', 'Delete me');
    await page.click('button:has-text("Create issue")');
    await expect(page).toHaveURL(/.*issues\/TEST/);

    page.on('dialog', (dialog) => dialog.accept());
    await page.click('button[title="Delete"]');

    await expect(page).toHaveURL(/.*issues/);
  });
});
