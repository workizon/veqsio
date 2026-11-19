import { test, expect } from '@playwright/test';

test.describe('Authentication', () => {
  test('login flow redirects to dashboard', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('text=Welcome to Veqsio')).toBeVisible();

    await page.fill('input[placeholder="Username"]', 'admin');
    await page.fill('input[placeholder="Password"]', 'admin123');
    await page.click('button:has-text("Sign In")');

    await expect(page).toHaveURL(/.*dashboard/);
    await expect(page.locator('text=Dashboard')).toBeVisible();
  });

  test('invalid credentials show error toast', async ({ page }) => {
    await page.goto('/');
    await page.fill('input[placeholder="Username"]', 'admin');
    await page.fill('input[placeholder="Password"]', 'wrong');
    await page.click('button:has-text("Sign In")');

    await expect(page.locator('text=Login failed')).toBeVisible();
  });

  test('password visibility toggle works', async ({ page }) => {
    await page.goto('/');
    const passwordInput = page.locator('input[placeholder="Password"]');
    await expect(passwordInput).toHaveAttribute('type', 'password');

    await page.click('button[type="button"]');
    await expect(passwordInput).toHaveAttribute('type', 'text');
  });
});
