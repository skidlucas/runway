import { expect, type Page, test } from "@playwright/test"
import { amountInput, formatMoney, parseAmount } from "../src/domain/money"
import { accountBalance, accountLink, open, openAccount, pickInCommand, waitForToast } from "./helpers"

test.describe.configure({ mode: "serial" })

const newOperation = async (page: Page, amount: string, payee: { query: string; option: string | RegExp }, category?: string) => {
  await page.getByRole("button", { name: "Opération", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Nouvelle opération" })
  await dialog.getByLabel("Montant").fill(amount)
  await pickInCommand(page, dialog.getByRole("button", { name: "Bénéficiaire" }), payee.query, payee.option)
  if (category) await pickInCommand(page, dialog.getByRole("button", { name: "Catégorie" }), category, new RegExp(`^${category}`))
  await dialog.getByRole("button", { name: "Ajouter" }).click()
  await waitForToast(page, "Opération ajoutée")
}

test("a transfer to savings moves money between the two accounts", async ({ page }) => {
  const checking = await accountBalance(page, "Compte courant")
  const savings = await accountBalance(page, "Livret A")

  await openAccount(page, "Compte courant")
  await newOperation(page, "150", { query: "Livret", option: "Livret A" })
  const sent = page.getByTestId("tx-row").filter({ hasText: "Livret A" }).filter({ hasText: "−150,00 €" })
  await expect(sent).toContainText("Virement")

  await openAccount(page, "Livret A")
  await expect(page.getByTestId("tx-row").filter({ hasText: "Compte courant" }).filter({ hasText: "+150,00 €" })).toHaveCount(1)
  expect(await accountBalance(page, "Compte courant")).toBe(checking - 150_00)
  expect(await accountBalance(page, "Livret A")).toBe(savings + 150_00)
})

test("splits an operation across two categories", async ({ page }) => {
  await openAccount(page, "Compte courant")
  await newOperation(page, "50", { query: "Grand Marché", option: "Créer « Grand Marché »" }, "Courses")
  const row = page.getByTestId("tx-row").filter({ hasText: "Grand Marché" })
  await row.hover()
  await row.getByRole("button", { name: /^Actions/ }).click()
  await page.getByRole("menuitem", { name: "Ventiler…" }).click()

  const editor = page.getByRole("dialog", { name: "Modifier l'opération" })
  await editor.getByRole("button", { name: "Ventiler" }).click()
  await editor.getByLabel("Montant ligne 1").fill("-30")
  await editor.getByPlaceholder("Note", { exact: true }).first().fill("part courses")
  await editor.getByLabel("Montant ligne 2").fill("-20")
  await pickInCommand(page, editor.getByRole("button", { name: "Catégorie", exact: true }), "Restaurants", /^Restaurants/)
  await editor.getByPlaceholder("Note", { exact: true }).last().fill("part resto")
  await expect(editor).toContainText("Équilibrée")
  await editor.getByRole("button", { name: "Enregistrer" }).click()
  await waitForToast(page, "Opération modifiée")

  await row.getByRole("button", { name: "Ventilée (2)" }).click()
  const lines = page.getByRole("table", { name: "Opérations" }).getByRole("row")
  await expect(lines.filter({ hasText: "part courses" })).toContainText("Courses")
  await expect(lines.filter({ hasText: "part courses" })).toContainText("−30,00 €")
  await expect(lines.filter({ hasText: "part resto" })).toContainText("Restaurants")
  await expect(lines.filter({ hasText: "part resto" })).toContainText("−20,00 €")
  await expect(row).toContainText("−50,00 €")
})

test("reconciles against a statement and books the difference", async ({ page }) => {
  await openAccount(page, "Compte courant")
  await page.getByRole("button", { name: "Rapprocher" }).click()
  const dialog = page.getByRole("dialog", { name: "Rapprocher Compte courant" })
  const statement = dialog.getByLabel("Solde du relevé")
  // The field starts on the cleared balance: a statement 1 € above it leaves a 1 € gap to book.
  const cleared = parseAmount(await statement.inputValue())
  expect(cleared).not.toBeNull()
  await statement.fill(amountInput(cleared! + 1_00))
  await expect(dialog).toContainText(`Écart de ${formatMoney(1_00)} : un ajustement sera créé`)
  await dialog.getByRole("button", { name: "Rapprocher" }).click()
  await waitForToast(page, `Compte rapproché · ajustement de ${formatMoney(1_00)}`)

  await expect(page.getByRole("button", { name: "Rapprochée" }).first()).toBeVisible()
  await open(page, "/accounts")
  await expect(accountLink(page, "Compte courant")).toContainText("rapproché le")
})

test("closes an account, then deletes it after confirming", async ({ page }) => {
  await open(page, "/accounts?new=true")
  const create = page.getByRole("dialog", { name: "Nouveau compte" })
  await create.getByLabel("Nom").fill("Compte vacances")
  await create.getByLabel("Solde actuel").fill("0")
  await create.getByRole("button", { name: "Créer" }).click()
  await waitForToast(page, "Compte créé")
  await expect(page).toHaveURL(/\/accounts\/[^/?]+$/)

  await page.getByRole("button", { name: "Actions du compte" }).click()
  await page.getByRole("menuitem", { name: "Clôturer le compte" }).click()
  await waitForToast(page, "Compte mis à jour")
  await open(page, "/accounts")
  await expect(page.getByRole("region", { name: "Clôturés" })).toContainText("Compte vacances")
  await expect(page.getByRole("region", { name: "Budget", exact: true })).not.toContainText("Compte vacances")

  await accountLink(page, "Compte vacances").click()
  await page.getByRole("button", { name: "Actions du compte" }).click()
  await page.getByRole("menuitem", { name: "Supprimer le compte" }).click()
  const confirm = page.getByRole("dialog", { name: /^Supprimer « Compte vacances »/ })
  await confirm.getByRole("button", { name: "Annuler" }).click()
  await expect(confirm).toHaveCount(0)
  await page.getByRole("button", { name: "Actions du compte" }).click()
  await page.getByRole("menuitem", { name: "Supprimer le compte" }).click()
  await page.getByTestId("confirm-dialog-confirm").click()
  await waitForToast(page, "Compte supprimé")
  await expect(page).toHaveURL(/\/accounts$/)
  await expect(page.getByRole("main").getByText("Compte vacances")).toHaveCount(0)
})
