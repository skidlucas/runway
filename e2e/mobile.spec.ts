import { expect, test } from "@playwright/test"
import { open, pickInCommand, visible, waitForToast } from "./helpers"

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

test("the budget shows one to-budget chip and category rows", async ({ page }) => {
  await open(page, "/budget")
  await expect(visible(page.getByTestId("to-budget"))).toHaveCount(1)
  await expect(page.getByRole("main").getByText("Courses", { exact: true })).toBeVisible()
})

test("moves money from a category that is not overspent", async ({ page }) => {
  await open(page, "/budget")
  const restaurants = page.getByRole("main").getByRole("button", { name: /^Restaurants/ })
  const before = await restaurants.textContent()
  await page.getByRole("main").getByRole("button", { name: /^Courses/ }).click()
  await visible(page.getByRole("button", { name: "Transférer…" })).click()
  const dialog = page.getByRole("dialog", { name: "Transférer depuis Courses" })
  await dialog.getByLabel("Montant").fill("10")
  await pickInCommand(page, dialog.getByRole("button", { name: "Une catégorie" }), "Restaurants", /^Restaurants/)
  await dialog.getByRole("button", { name: "Valider" }).click()
  await waitForToast(page, "Budget mis à jour")
  await expect(restaurants).not.toHaveText(before ?? "")
})

test("wealth opens an asset in a sheet", async ({ page }) => {
  await open(page, "/wealth")
  // The last desktop spec replaced everything with an Actual export: only accounts are left.
  await page.getByRole("main").getByRole("button", { name: /^Compte courant/ }).click()
  await expect(visible(page.getByTestId("asset-detail"))).toContainText("Valeur retenue")
  await expect(visible(page.getByTestId("asset-detail"))).toContainText("11 576 €")
})
