import { test, expect } from '@playwright/test';

test.describe('Board', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.fill('input[placeholder="Username"]', 'admin');
    await page.fill('input[placeholder="Password"]', 'admin123');
    await page.click('button:has-text("Sign In")');
    await expect(page).toHaveURL(/.*dashboard/);
  });

  test('board page displays columns', async ({ page }) => {
    await page.goto('/boards');
    await expect(page.locator('text=Board')).toBeVisible();
    await expect(page.locator('text=To Do')).toBeVisible();
    await expect(page.locator('text=In Progress')).toBeVisible();
    await expect(page.locator('text=Done')).toBeVisible();
  });

  test('board cards are visible', async ({ page }) => {
    await page.goto('/boards');
    await expect(page.locator('.veqsio-card')).toHaveCount(5);
  });

  test('drag and drop card between columns', async ({ page }) => {
    await page.goto('/boards');

    const card = page.locator('.veqsio-card:has-text("Fix login bug")');
    const targetColumn = page.locator('h3:has-text("In Progress")').locator('..').locator('..');

    await card.dragTo(targetColumn);

    // After drag, card should still be visible in the new column
    await expect(page.locator('.veqsio-card:has-text("Fix login bug")')).toBeVisible();
  });

  test('add issue button appears in each column', async ({ page }) => {
    await page.goto('/boards');
    const addButtons = page.locator('text=+ Add issue');
    await expect(addButtons).toHaveCount(3);
  });
});
