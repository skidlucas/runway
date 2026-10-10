import { expect, test } from "@playwright/test"
import { formatMoney } from "../src/domain/money"
import { amountIn, cents, open, pickInCommand, visible, waitForToast } from "./helpers"

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
  // The backup spec replaced everything with an Actual export: only accounts are left.
  const account = page.getByRole("main").getByRole("button", { name: /^Compte courant/ })
  const value = await amountIn(account)
  await account.click()
  await expect(visible(page.getByTestId("asset-detail"))).toContainText("Valeur retenue")
  await expect(visible(page.getByTestId("asset-detail"))).toContainText(formatMoney(value, { decimals: 0 }))
})

test("enters an expense from the keypad", async ({ page }) => {
  await open(page, "/budget")
  await page.getByRole("button", { name: "Nouvelle opération" }).click()
  const sheet = page.getByRole("dialog", { name: "Nouvelle opération" })
  for (const key of ["1", "2", ",", "4", "0"]) await sheet.getByRole("button", { name: key, exact: true }).click()
  await expect(sheet).toContainText("12,40 €")
  await pickInCommand(page, sheet.getByRole("button", { name: "Choisir" }).first(), "Fleuriste", "Créer « Fleuriste »")
  await expect(sheet.getByRole("button", { name: "Depuis une photo" })).toHaveCount(0)
  await sheet.getByLabel("Note").fill("Pivoines")
  await sheet.getByRole("button", { name: "OK", exact: true }).click()
  await waitForToast(page, "Opération ajoutée")
  await expect(sheet).toHaveCount(0)

  await page.getByRole("navigation", { name: "Navigation" }).getByRole("link", { name: "Comptes" }).click()
  await page.getByRole("main").getByRole("link", { name: /^Compte courant/ }).click()
  // Searching the note finds it: the note was saved with the operation.
  await page.getByLabel("Rechercher une opération").fill("Pivoines")
  await expect(page.getByRole("main").getByRole("button", { name: /^Fleuriste/ })).toBeVisible()
  await expect(page.getByRole("main").getByText("−12,40 €", { exact: true })).toBeVisible()
})

test("the account header keeps the balance and the cleared balance in view while the operations scroll", async ({ page }) => {
  await open(page, "/accounts")
  await page.getByRole("main").getByRole("link", { name: /^Compte courant/ }).click()
  const header = page.locator("header").filter({ hasText: "Compte courant" })
  await expect(header).toContainText(/Pointé\s+[−-]?[\d\s]+,\d\d\s€/)
  await page.mouse.wheel(0, 2000)
  await expect(header).toBeInViewport()
  await expect(header).toContainText("Pointé")
})

test("swiping an operation clears it, which moves the cleared balance", async ({ page }) => {
  await open(page, "/accounts")
  await page.getByRole("main").getByRole("link", { name: /^Compte courant/ }).click()
  const header = page.locator("header").filter({ hasText: "Compte courant" })
  const clearedBalance = async () => cents((await header.getByText(/^Pointé/).innerText()).replace("Pointé", ""))
  const before = await clearedBalance()
  await page.getByLabel("Rechercher une opération").fill("Fleuriste")
  const row = page.getByRole("main").getByRole("button", { name: /^Fleuriste/ })
  const clear = page.getByRole("button", { name: "Pointer", exact: true })
  await expect(clear).toHaveCount(1)
  const box = await row.boundingBox()
  if (!box) throw new Error("Fleuriste row not laid out")
  const at = (x: number) => ({ touches: [{ identifier: 0, clientX: x, clientY: box.y + box.height / 2 }] })
  await row.dispatchEvent("touchstart", at(box.x + box.width - 10))
  await row.dispatchEvent("touchmove", at(box.x - 200))
  await row.dispatchEvent("touchend", { touches: [] })
  await clear.click()
  await expect.poll(clearedBalance).toBe(before - 1240)
})
