import { expect, test } from "@playwright/test"
import { open, pickInCommand, visible, waitForToast } from "./helpers"

test.describe.configure({ mode: "serial" })

test("starts from an empty budget with the starter categories", async ({ page }) => {
  await open(page, "/budget")
  await page.getByRole("button", { name: "Créer les catégories types" }).click()
  await expect(page.getByRole("table", { name: "Budget du mois" })).toBeVisible()
  await expect(page.getByRole("button", { name: /^Budget Courses/ })).toBeVisible()
})

test("creates an account with its opening balance", async ({ page }) => {
  await open(page, "/accounts?new=true")
  const dialog = page.getByRole("dialog", { name: "Nouveau compte" })
  await dialog.getByLabel("Nom").fill("Compte joint")
  await dialog.getByLabel("Solde actuel").fill("1500")
  await dialog.getByRole("button", { name: "Créer" }).click()
  await waitForToast(page, "Compte créé")
  await expect(page).toHaveURL(/\/accounts\/[^/?]+$/)
  await open(page, "/accounts")
  await expect(page.getByRole("link", { name: /Compte joint 1 opération 1 500,00 €/ })).toBeVisible()
})

test("enters an expense and updates the balance", async ({ page }) => {
  await open(page, "/accounts")
  await page.getByRole("main").getByRole("link", { name: /Compte joint/ }).click()
  await page.getByRole("button", { name: "Opération", exact: true }).click()

  const dialog = page.getByRole("dialog", { name: "Nouvelle opération" })
  await dialog.getByLabel("Montant").fill("42,50")
  await pickInCommand(page, dialog.getByRole("button", { name: "Bénéficiaire" }), "Boulangerie", "Créer « Boulangerie »")
  await pickInCommand(page, dialog.getByRole("button", { name: "Catégorie" }), "Courses", /^Courses/)
  await dialog.getByRole("button", { name: "Ajouter" }).click()

  const row = page.getByTestId("tx-row").filter({ hasText: "Boulangerie" })
  await expect(row).toContainText("Courses")
  await expect(row).toContainText("−42,50 €")
  await expect(page.getByRole("main").getByText("1 457,50 €").first()).toBeVisible()
})

test("budgets a category from the month view", async ({ page }) => {
  await open(page, "/budget")
  const toBudget = visible(page.getByTestId("to-budget"))
  await expect(toBudget).toContainText("1 500,00 €")

  await page.getByRole("button", { name: /^Budget Courses/ }).click()
  await page.getByRole("textbox", { name: "Budget Courses" }).fill("200")
  await page.getByRole("textbox", { name: "Budget Courses" }).press("Enter")

  const courses = page.getByRole("row").filter({ has: page.getByRole("link", { name: "Courses", exact: true }) })
  await expect(courses).toContainText("200,00 €")
  await expect(courses.getByRole("button", { name: "Disponible Courses" })).toHaveText("157,50 €")
  await expect(toBudget).toContainText("1 300,00 €")
})
