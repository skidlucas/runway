import { expect, test } from "@playwright/test"
import { open, visible } from "./helpers"

const tabs = [
  { name: "Accueil", url: /\/forecast/ },
  { name: "Budget", url: /\/budget/ },
  { name: "Comptes", url: /\/accounts/ },
  { name: "Insights", url: /\/insights/ },
  { name: "Plus", url: /\/more/ },
]

test("the tab bar reaches every section without horizontal scroll", async ({ page }) => {
  await open(page, "/budget")
  const nav = page.getByRole("navigation", { name: "Navigation" })
  for (const tab of tabs) {
    await nav.getByRole("link", { name: tab.name }).click()
    await expect(page).toHaveURL(tab.url)
    await expect(page.getByRole("main")).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  }
  await page.getByRole("link", { name: /Patrimoine/ }).click()
  await expect(page).toHaveURL(/\/wealth/)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})

test("the budget shows one to-budget chip and category cards", async ({ page }) => {
  await open(page, "/budget")
  await expect(visible(page.getByTestId("to-budget"))).toHaveCount(1)
  await expect(page.getByRole("main").getByText("Courses", { exact: true })).toBeVisible()
})

test("wealth opens an asset in a sheet", async ({ page }) => {
  await open(page, "/wealth")
  // The last desktop spec replaced everything with an Actual export: only accounts are left.
  await page.getByRole("main").getByRole("button", { name: /^Compte courant/ }).click()
  await expect(visible(page.getByTestId("asset-detail"))).toContainText("Valeur retenue")
  await expect(visible(page.getByTestId("asset-detail"))).toContainText("11 576 €")
})
