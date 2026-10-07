import { expect, type Page, test } from "@playwright/test"
import { firstDay, formatDayInput, formatDayLong, monthOf } from "../src/domain/dates"
import { inDays, open, pickInCommand, visible, waitForToast } from "./helpers"

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
  await expect(page.getByRole("main").getByRole("group", { name: "Aujourd'hui" })).toContainText("1 457,50 €")
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

test("shows what a schedule needs in the budget and budgets it", async ({ page }) => {
  await open(page, "/schedules")
  await page.getByRole("button", { name: "Nouvelle échéance" }).first().click()
  const dialog = page.getByRole("dialog", { name: "Nouvelle échéance" })
  await dialog.getByLabel("Nom").fill("Box")
  await dialog.getByLabel("Montant").fill("30")
  await pickInCommand(page, dialog.getByRole("button", { name: "Catégorie" }), "Internet", /^Internet/)
  await dialog.getByLabel("Première date", { exact: true }).fill(inDays(0))
  await dialog.getByLabel("Fin (optionnel)").fill(inDays(70))
  await dialog.getByRole("button", { name: "Enregistrer" }).click()
  await waitForToast(page, "Échéance créée")
  await expect(page.getByTestId("schedule-row").filter({ hasText: "Box" })).toContainText(/reste \d+ × 30,00\s€/)

  await open(page, "/budget")
  await page.getByRole("button", { name: /^Prévu Internet : 30,00\s€/ }).click()
  await page.getByRole("button", { name: /^Budgéter 30,00\s€/ }).click()
  await expect(page.getByRole("button", { name: /^Budget Internet/ })).toHaveText(/^30,00\s€$/)
})

const openJointAccount = async (page: Page) => {
  await open(page, "/accounts")
  await page.getByRole("main").getByRole("link", { name: /Compte joint/ }).click()
  await expect(page.getByTestId("tx-row").first()).toBeVisible()
}

test("deletes an operation and brings it back from the toast", async ({ page }) => {
  await openJointAccount(page)
  const row = page.getByTestId("tx-row").filter({ hasText: "Boulangerie" })
  await row.hover()
  await row.getByRole("button", { name: "Actions" }).click()
  await page.getByRole("menuitem", { name: "Supprimer" }).click()
  const deleted = page.getByRole("status").filter({ hasText: "1 opération supprimée" })
  await expect(deleted).toBeVisible()
  await expect(row).toHaveCount(0)
  await deleted.getByRole("button", { name: "Annuler" }).click()
  await waitForToast(page, "Suppression annulée")
  await expect(row).toContainText("−42,50 €")
})

test("deletes a selection without asking and brings it back from the toast", async ({ page }) => {
  await openJointAccount(page)
  const row = page.getByTestId("tx-row").filter({ hasText: "Boulangerie" })
  await row.getByRole("checkbox", { name: "Sélectionner" }).click()
  await page.getByRole("button", { name: "Supprimer", exact: true }).click()
  const deleted = page.getByRole("status").filter({ hasText: "1 opération supprimée" })
  await expect(row).toHaveCount(0)
  await deleted.getByRole("button", { name: "Annuler" }).click()
  await waitForToast(page, "Suppression annulée")
  await expect(row).toContainText("−42,50 €")
})

test("plans an operation dated after today as a schedule, outside today's balance", async ({ page }) => {
  await openJointAccount(page)
  await page.getByRole("button", { name: "Opération", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Nouvelle opération" })
  await dialog.getByLabel("Montant").fill("10")
  await pickInCommand(page, dialog.getByRole("button", { name: "Bénéficiaire" }), "Pressing", "Créer « Pressing »")
  await dialog.getByLabel("Date").fill(inDays(3))
  await expect(dialog.getByText("Sera créée comme échéance")).toBeVisible()
  await dialog.getByRole("button", { name: "Créer l'échéance" }).click()
  await waitForToast(page, "Échéance créée pour le")

  await expect(page.getByRole("main").getByRole("group", { name: "Aujourd'hui" })).toContainText("1 457,50 €")
  await expect(page.getByTestId("tx-row").filter({ hasText: "Pressing" })).toHaveCount(0)
  const line = page.getByTestId("scheduled-row").filter({ hasText: "Pressing" })
  await expect(line).toContainText("Échéance")
  await expect(line).toContainText("−10,00 €")
})

test("moves an operation to another day from the register, and into a schedule after today", async ({ page }) => {
  await openJointAccount(page)
  await page.getByRole("button", { name: "Opération", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Nouvelle opération" })
  await dialog.getByLabel("Montant").fill("5")
  await pickInCommand(page, dialog.getByRole("button", { name: "Bénéficiaire" }), "Cordonnier", "Créer « Cordonnier »")
  await dialog.getByRole("button", { name: "Ajouter" }).click()
  await waitForToast(page, "Opération ajoutée")

  const row = page.getByTestId("tx-row").filter({ hasText: "Cordonnier" })
  const yesterday = inDays(-1)
  await row.getByTitle(formatDayLong(inDays(0))).click()
  await page.getByRole("dialog").getByLabel("Date").fill(formatDayInput(yesterday))
  await page.keyboard.press("Enter")
  await expect(page.getByRole("dialog")).toHaveCount(0)

  await row.getByTitle(formatDayLong(yesterday)).click()
  await expect(page.getByRole("dialog").getByLabel("Date")).toHaveValue(formatDayInput(yesterday))
  await page.getByRole("dialog").getByLabel("Date").fill(formatDayInput(inDays(3)))
  await page.keyboard.press("Enter")
  await waitForToast(page, "Opération transformée en échéance du")
  await expect(row).toHaveCount(0)
  await expect(page.getByTestId("scheduled-row").filter({ hasText: "Cordonnier" })).toContainText("−5,00 €")
})

test("plans a one-off schedule and shows it in the register and the account forecast", async ({ page }) => {
  await open(page, "/schedules")
  await page.getByRole("button", { name: "Nouvelle échéance" }).first().click()
  const dialog = page.getByRole("dialog", { name: "Nouvelle échéance" })
  await dialog.getByLabel("Nom").fill("Dentiste")
  await dialog.getByLabel("Montant").fill("60")
  await dialog.getByLabel("Fréquence").click()
  await page.getByRole("option", { name: "Une seule fois" }).click()
  await expect(dialog.getByText("Fin (optionnel)")).toHaveCount(0)
  await dialog.getByLabel("Date", { exact: true }).fill(inDays(2))
  await dialog.getByRole("button", { name: "Enregistrer" }).click()
  await waitForToast(page, "Échéance créée")

  await openJointAccount(page)
  const line = page.getByTestId("scheduled-row").filter({ hasText: "Dentiste" })
  await expect(line).toContainText("Échéance")
  await expect(line).toContainText("−60,00 €")
  await page.getByLabel("Rechercher une opération").fill("Pressing")
  await expect(line).toHaveCount(0)
  await page.getByLabel("Rechercher une opération").fill("")

  await open(page, "/forecast")
  const tabs = page.getByRole("tablist", { name: "Compte" })
  await expect(tabs.getByRole("tab", { name: "Compte joint" })).toHaveAttribute("aria-selected", "true")
  await expect(page.getByText(/Seules les échéances et les opérations déjà saisies sont comptées/)).toBeVisible()
  await expect(tabs.getByRole("tab").last()).toHaveText("Tous")
  await tabs.getByRole("tab", { name: "Tous" }).click()
  await expect(page).toHaveURL(/account=all/)
  await expect(page.getByText("Comptes inclus : Compte joint")).toBeVisible()
})

test("saves the short date typed just before pressing Enter", async ({ page }) => {
  await openJointAccount(page)
  await page.getByRole("button", { name: "Opération", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Nouvelle opération" })
  await dialog.getByLabel("Montant").fill("3")
  await pickInCommand(page, dialog.getByRole("button", { name: "Bénéficiaire" }), "Kiosque", "Créer « Kiosque »")
  await dialog.getByLabel("Date").fill("1")
  await dialog.getByLabel("Date").press("Enter")
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId("tx-row").filter({ hasText: "Kiosque" }).getByTitle(formatDayLong(firstDay(monthOf(inDays(0)))))).toBeVisible()
})
