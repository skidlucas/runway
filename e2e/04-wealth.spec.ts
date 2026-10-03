import { expect, test } from "@playwright/test"
import { cents, open, visible, waitForToast } from "./helpers"

test.describe.configure({ mode: "serial" })

test("adds a manual asset and switches its retained value", async ({ page }) => {
  await open(page, "/wealth")
  const netWorth = visible(page.getByTestId("net-worth"))
  await expect(netWorth).toHaveText(/€/)
  const before = cents(await netWorth.innerText())

  await page.getByRole("button", { name: "Ajouter un bien" }).first().click()
  const dialog = page.getByRole("dialog", { name: "Ajouter un bien" })
  await dialog.getByLabel("Nom").fill("Rolex Submariner")
  await dialog.getByRole("combobox", { name: "Type" }).selectOption({ label: "Montre" })
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

test("adds a loan and nets it against real estate", async ({ page }) => {
  await open(page, "/wealth")
  const netWorth = visible(page.getByTestId("net-worth"))
  await expect(netWorth).toHaveText(/€/)
  const before = cents(await netWorth.innerText())

  await page.getByRole("button", { name: "Ajouter un bien" }).first().click()
  const dialog = page.getByRole("dialog", { name: "Ajouter un bien" })
  await dialog.getByLabel("Nom").fill("Crédit test")
  await dialog.getByRole("combobox", { name: "Type" }).selectOption({ label: "Emprunt" })
  await dialog.getByLabel("Capital emprunté").fill("100000")
  await dialog.getByLabel("Taux annuel (%)").fill("0")
  await dialog.getByLabel("Durée (années)").fill("10")
  await dialog.getByLabel("Date de déblocage").fill("2020-01-01")
  await dialog.getByRole("button", { name: "Ajouter" }).click()

  // 100 000 € over 120 months at 0 %: 833,33 € less owed each month since 2020.
  const row = page.getByTestId("asset-row").filter({ hasText: "Crédit test" })
  await expect(row).toContainText("Tableau d'amortissement")
  const owed = cents((await row.innerText()).split("\n").find((l) => l.includes("€"))!)
  expect(owed).toBeLessThan(0)
  expect(owed).toBeGreaterThan(-100_000_00)
  await expect.poll(async () => cents(await netWorth.innerText())).toBe(before + owed)

  await page.getByTestId("asset-row").filter({ hasText: "Crédit test" }).click()
  page.once("dialog", (d) => d.accept())
  await visible(page.getByTestId("asset-detail")).getByRole("button", { name: "Actions du bien" }).click()
  await page.getByRole("menuitem", { name: "Supprimer" }).click()
  await waitForToast(page, "Bien supprimé")
  await expect.poll(async () => cents(await netWorth.innerText())).toBe(before)
})
