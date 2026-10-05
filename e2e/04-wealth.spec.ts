import { expect, test } from "@playwright/test"
import { amountIn, cents, open, visible, waitForToast } from "./helpers"

test.describe.configure({ mode: "serial" })

test("adds a manual asset and switches its retained value", async ({ page }) => {
  await open(page, "/wealth")
  const netWorth = visible(page.getByTestId("net-worth"))
  await expect(netWorth).toHaveText(/€/)
  const before = cents(await netWorth.innerText())

  await page.getByRole("button", { name: "Ajouter un bien" }).first().click()
  const dialog = page.getByRole("dialog", { name: "Ajouter un bien" })
  await dialog.getByLabel("Nom").fill("Rolex Submariner")
  await dialog.getByRole("combobox", { name: "Type" }).click()
  await page.getByRole("option", { name: "Montre" }).click()
  await dialog.getByLabel("Prix d'achat").fill("6800")
  await dialog.getByLabel("Date d'achat").fill("2015-03-10")
  await dialog.getByRole("radiogroup", { name: "Valeur retenue dans le total" }).getByRole("radio", { name: "Achat" }).click()
  await dialog.getByRole("button", { name: "Ajouter" }).click()

  await expect(page.getByTestId("asset-row").filter({ hasText: "Rolex Submariner" })).toBeVisible()
  await expect.poll(async () => cents(await netWorth.innerText())).toBe(before + 6_800_00)

  const detail = visible(page.getByTestId("asset-detail"))
  await expect(detail).toContainText("Rolex Submariner")
  await detail.getByLabel("Montant de l'estimation").fill("10 200")
  await detail.getByRole("button", { name: "Ajouter" }).click()
  await expect(detail).toContainText("Saisie manuelle")

  await detail.getByRole("button", { name: /Estimée/ }).click()
  await expect(detail).toContainText("Valeur retenue · estimée")
  await expect.poll(async () => cents(await netWorth.innerText())).toBe(before + 10_200_00)
})

test("the sidebar sums assets by type and opens the page on that type", async ({ page }) => {
  await open(page, "/budget")
  const sidebar = page.getByRole("complementary").first()
  await expect(sidebar.getByRole("link", { name: /^Montres/ })).toContainText("10 200 €")
  await sidebar.getByRole("link", { name: /^Montres/ }).click()
  await expect(page).toHaveURL(/\/wealth\?type=watch/)
  await expect(page.getByTestId("asset-row")).toHaveCount(1)
  await page.getByRole("tab", { name: "Tout" }).click()
  await expect(page).not.toHaveURL(/type=/)
  await expect(page.getByTestId("net-worth")).toBeVisible()

  await sidebar.getByRole("link", { name: "Ajouter un bien" }).click()
  await expect(page.getByRole("dialog", { name: "Ajouter un bien" })).toBeVisible()
})

test("adds a loan and nets it against real estate", async ({ page }) => {
  await open(page, "/wealth")
  const netWorth = visible(page.getByTestId("net-worth"))
  await expect(netWorth).toHaveText(/€/)
  const before = cents(await netWorth.innerText())

  await page.getByRole("button", { name: "Ajouter un bien" }).first().click()
  const dialog = page.getByRole("dialog", { name: "Ajouter un bien" })
  await dialog.getByLabel("Nom").fill("Crédit test")
  await dialog.getByRole("combobox", { name: "Type" }).click()
  await page.getByRole("option", { name: "Emprunt" }).click()
  await dialog.getByLabel("Capital emprunté").fill("100000")
  await dialog.getByLabel("Taux annuel (%)").fill("0")
  await dialog.getByLabel("Durée (années)").fill("10")
  await dialog.getByLabel("Date de 1re échéance").fill("2020-02-01")
  await dialog.getByRole("button", { name: "Ajouter" }).click()

  // 100 000 € over 120 months at 0 %: 833,33 € less owed each month since 2020.
  const row = page.getByTestId("asset-row").filter({ hasText: "Crédit test" })
  await expect(row).toContainText("Tableau d'amortissement")
  const owed = await amountIn(row)
  expect(owed).toBeLessThan(0)
  expect(owed).toBeGreaterThan(-100_000_00)
  await expect.poll(async () => cents(await netWorth.innerText())).toBe(before + owed)

  // Deferring the first installment leaves one installment more owed today (the row shows whole euros).
  await row.click()
  await visible(page.getByTestId("asset-detail")).getByRole("button", { name: "Tableau d'amortissement" }).click()
  const schedule = page.getByRole("dialog", { name: "Tableau d'amortissement" })
  await expect(schedule.getByTestId("loan-row")).toHaveCount(120)
  await schedule.getByRole("button", { name: /^Actions de l'échéance de février 2020$/i }).click()
  await page.getByRole("menuitem", { name: "Intérêts seuls" }).click()
  await expect(schedule.getByTestId("loan-row").first()).toContainText("Intérêts seuls")
  await expect.poll(async () => Math.abs((await amountIn(row)) - (owed - 833_33))).toBeLessThan(100)
  await expect(schedule.getByTestId("loan-row")).toHaveCount(121)
  await page.keyboard.press("Escape")

  await visible(page.getByTestId("asset-detail")).getByRole("button", { name: "Actions du bien" }).click()
  await page.getByRole("menuitem", { name: "Supprimer" }).click()
  await page.getByTestId("confirm-dialog-confirm").click()
  await waitForToast(page, "Bien supprimé")
  await expect.poll(async () => cents(await netWorth.innerText())).toBe(before)
})

test("counts only the part owned of an asset bought together", async ({ page }) => {
  await open(page, "/wealth")
  const netWorth = visible(page.getByTestId("net-worth"))
  await expect(netWorth).toHaveText(/€/)
  const before = cents(await netWorth.innerText())

  await page.getByRole("button", { name: "Ajouter un bien" }).first().click()
  const dialog = page.getByRole("dialog", { name: "Ajouter un bien" })
  await dialog.getByLabel("Nom").fill("Voiture à deux")
  await dialog.getByRole("combobox", { name: "Type" }).click()
  await page.getByRole("option", { name: "Véhicule" }).click()
  await dialog.getByLabel("Part détenue (%)").fill("50")
  await dialog.getByLabel("Prix d'achat").fill("20000")
  await dialog.getByRole("radiogroup", { name: "Valeur retenue dans le total" }).getByRole("radio", { name: "Achat" }).click()
  await dialog.getByRole("button", { name: "Ajouter" }).click()

  const row = page.getByTestId("asset-row").filter({ hasText: "Voiture à deux" })
  await expect(row).toContainText("50 %")
  await expect(row).toContainText("10 000 €")
  await expect.poll(async () => cents(await netWorth.innerText())).toBe(before + 10_000_00)
  await expect(page.getByTestId("asset-row").filter({ hasText: "Rolex Submariner" })).not.toContainText("%")

  await row.click()
  const detail = visible(page.getByTestId("asset-detail"))
  await expect(detail).toContainText("sur 20 000 € au total")
  await detail.getByRole("button", { name: "Actions du bien" }).click()
  await page.getByRole("menuitem", { name: "Supprimer" }).click()
  await page.getByTestId("confirm-dialog-confirm").click()
  await waitForToast(page, "Bien supprimé")
  await expect.poll(async () => cents(await netWorth.innerText())).toBe(before)
})
