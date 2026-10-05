import { expect, type Page, test } from "@playwright/test"
import { E2E_PASSWORD, hydrated, open, openAccount, pickInCommand, waitForToast } from "./helpers"

test.describe.configure({ mode: "serial" })

const categoryRow = (page: Page, name: string) =>
  page.getByTestId("category-settings-row").filter({ has: page.getByRole("button", { name, exact: true }) })

const deleteCategory = async (page: Page, name: string, moveTo?: string) => {
  const row = categoryRow(page, name)
  await row.hover()
  await row.getByRole("button", { name: "Supprimer" }).click()
  const dialog = page.getByRole("dialog", { name: `Supprimer « ${name} »` })
  if (moveTo) await pickInCommand(page, dialog.getByRole("button", { name: "Transférer vers" }), moveTo, new RegExp(`^${moveTo}`))
  await dialog.getByTestId("confirm-dialog-confirm").click()
  await waitForToast(page, "Supprimé")
  await expect(row).toHaveCount(0)
}

test("deleting a category can move its operations to another one", async ({ page }) => {
  await open(page, "/settings/categories")
  await page.getByRole("button", { name: "Ajouter une catégorie" }).first().click()
  await page.getByPlaceholder("Nom de la catégorie").fill("Pressing pro")
  await page.getByRole("button", { name: "Ajouter", exact: true }).click()
  await expect(categoryRow(page, "Pressing pro")).toHaveCount(1)

  await openAccount(page, "Compte courant")
  await page.getByRole("button", { name: "Opération", exact: true }).click()
  const entry = page.getByRole("dialog", { name: "Nouvelle opération" })
  await entry.getByLabel("Montant").fill("18")
  await pickInCommand(page, entry.getByRole("button", { name: "Bénéficiaire" }), "Pressing Lavoir", "Créer « Pressing Lavoir »")
  await pickInCommand(page, entry.getByRole("button", { name: "Catégorie" }), "Pressing pro", /^Pressing pro/)
  await entry.getByRole("button", { name: "Ajouter" }).click()
  const row = page.getByTestId("tx-row").filter({ hasText: "Pressing Lavoir" })
  await expect(row).toContainText("Pressing pro")

  await open(page, "/settings/categories")
  await deleteCategory(page, "Pressing pro", "Courses")
  await openAccount(page, "Compte courant")
  await expect(row).toContainText("Courses")
})

test("deleting a category without a replacement leaves its operations to categorize", async ({ page }) => {
  await open(page, "/settings/categories")
  await deleteCategory(page, "Vieux loisir")
  await open(page, "/budget")
  await expect(page.getByRole("link", { name: "Vieux loisir", exact: true })).toHaveCount(0)
})

test("signs out, and the password lets back in", async ({ page }) => {
  await open(page, "/settings")
  // Signing out redirects client-side first, then reloads /login: navigating before that reload
  // lands would be aborted by it.
  const reloaded = page.waitForEvent("load")
  await page.getByRole("button", { name: "Se déconnecter", exact: true }).click()
  await reloaded
  await expect(page).toHaveURL(/\/login/)
  await hydrated(page)
  await open(page, "/budget")
  await expect(page).toHaveURL(/\/login/)

  await page.getByLabel("Mot de passe").fill(E2E_PASSWORD)
  await page.getByRole("button", { name: "Entrer" }).click()
  await expect(page).toHaveURL(/\/budget/)
  await expect(page.getByRole("table", { name: "Budget du mois" })).toBeVisible()
})
