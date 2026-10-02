const { test, expect } = require("@playwright/test");

async function login(page, email) {
  await page.goto("/");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("AttendlyDemo!2026");
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
}

test("admin dashboard, management forms, filters and CSV export", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await login(page, "admin@example.com");
  await expect(page.getByRole("heading", { name: "Attendance overview" })).toBeVisible();
  await expect(page.locator(".stat").filter({ hasText: "Class strength" }).locator(".stat-value")).toHaveText("60");
  await expect(page.locator(".stat").filter({ hasText: "Valid attendance" }).locator(".stat-value")).toHaveText("55");
  await expect(page.locator(".stat").filter({ hasText: "Under review" }).locator(".stat-value")).toHaveText("2");
  await page.screenshot({ path: "test-results/dashboard-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Students", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Student directory" })).toBeVisible();
  await page.getByRole("button", { name: "Add student", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByLabel("Search current view").fill("CS-060");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.getByRole("button", { name: "Courses", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your courses" })).toBeVisible();
  await page.getByRole("button", { name: "Add course", exact: true }).click();
  await expect(page.getByLabel("Assigned faculty")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Reports", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(60);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download CSV" }).click();
  expect((await download).suggestedFilename()).toMatch(/attendance-daily/);
  await page.getByRole("button", { name: "Activity & review" }).click();
  await expect(page.getByRole("heading", { name: "Activity & review" })).toBeVisible();
  await page.getByRole("button", { name: "Audit trail" }).click();
  await expect(page.locator(".activity-item").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("faculty generates a real QR and views attendance", async ({ page }) => {
  await login(page, "faculty@example.com");
  await page.getByRole("button", { name: "Generate QR", exact: true }).click();
  await expect(page.getByRole("img", { name: "Classroom check-in QR code" })).toBeVisible();
  await expect(page.locator("#qr-countdown")).toHaveText(/0[45]:\d\d/);
  const link = await page.getByLabel("QR check-in URL").inputValue();
  expect(link).toContain("/#session=");
  expect(link).toContain("&token=");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "View all attendance" }).click();
  await page.getByLabel("Attendance status").selectOption("UNDER_REVIEW");
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await page.getByRole("button", { name: "Review", exact: true }).first().click();
  await expect(page.getByLabel("Reason for decision")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("student history, invalid check-in, and mobile layout", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "student60@example.com");
  await expect(page.getByRole("button", { name: "Students", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "My attendance", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.getByRole("button", { name: "Check in", exact: true }).click();
  await page.getByLabel("QR check-in link").fill(`${new URL(page.url()).origin}/#session=1&token=invalid-token-value`);
  await page.getByRole("button", { name: "Submit attendance" }).click();
  await expect(page.locator("#scan-form .form-error")).toContainText("INVALID_QR");
  const overflows = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflows).toBe(false);
  await page.screenshot({ path: "test-results/checkin-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "Sign out", exact: true }).filter({ visible: true }).click();
  await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
});