import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { accountBalance, open, openAccount, pickInCommand, waitForToast } from "./helpers"

test.describe.configure({ mode: "serial" })

// Small statements dated September 2026, on top of the Actual fixture the backup spec restored.
const fixture = (name: string) => join(process.cwd(), "e2e/fixtures", name)

const importBankFile = async (page: Page, file: string, account: string, expected: { read: number; toast: string | RegExp }) => {
  await open(page, "/settings/data")
  await page.getByTestId("import-file").setInputFiles(fixture(file))
  const dialog = page.getByRole("dialog", { name: `Importer « ${file} »` })
  await expect(dialog).toContainText(`${expected.read} opération`)
  await dialog.getByRole("combobox", { name: "Compte" }).click()
  await page.getByRole("option", { name: account, exact: true }).click()
  await dialog.getByRole("button", { name: /^Importer \d+ opération/ }).click()
  await waitForToast(page, expected.toast)
  await expect(dialog).toHaveCount(0)
}

const searchRegister = async (page: Page, account: string, text: string) => {
  await openAccount(page, account)
  await page.getByLabel("Rechercher une opération").fill(text)
  return page.getByTestId("tx-row").filter({ hasText: text })
}

test("imports a CSV statement with debit and credit columns", async ({ page }) => {
  const before = await accountBalance(page, "Compte courant")
  await importBankFile(page, "releve.csv", "Compte courant", { read: 2, toast: "2 opérations importées" })
  expect(await accountBalance(page, "Compte courant")).toBe(before - 8_40 + 23_00)
  const rows = await searchRegister(page, "Compte courant", "BOULANGERIE")
  await expect(rows).toHaveCount(1)
  await expect(rows).toContainText("−8,40 €")
  await expect(rows).toContainText("À catégoriser")
})

test("a new rule categorizes the operations already imported", async ({ page }) => {
  await open(page, "/settings/rules")
  const rules = page.getByTestId("rule-row")
  const count = await rules.count()
  await page.getByRole("button", { name: "Nouvelle règle" }).click()
  const dialog = page.getByRole("dialog", { name: "Nouvelle règle" })
  // A new rule starts on "the bank label contains".
  await dialog.getByLabel("Valeur").fill("BOULANGERIE")
  await pickInCommand(page, dialog.getByRole("button", { name: "Catégorie", exact: true }), "Courses", /^Courses/)
  await expect(dialog).toContainText("BOULANGERIE")
  await dialog.getByRole("button", { name: "Enregistrer" }).click()
  await waitForToast(page, "Règle créée")
  await expect(rules).toHaveCount(count + 1)
  await expect(rules.filter({ hasText: "BOULANGERIE" })).toContainText("Courses")

  const rows = await searchRegister(page, "Compte courant", "BOULANGERIE")
  await expect(rows).toContainText("Courses")
})

test("an OFX statement is categorized on arrival and its lines are not imported twice", async ({ page }) => {
  await importBankFile(page, "releve.ofx", "Compte courant", { read: 2, toast: "2 opérations importées" })
  const rows = await searchRegister(page, "Compte courant", "BOULANGERIE")
  await expect(rows).toHaveCount(2)
  for (const row of await rows.all()) await expect(row).toContainText("Courses")

  await importBankFile(page, "releve.ofx", "Compte courant", { read: 2, toast: "0 opération importée · 2 doublons ignorés" })
  await expect(await searchRegister(page, "Compte courant", "BOULANGERIE")).toHaveCount(2)
})

test("imports a QIF statement into the account picked", async ({ page }) => {
  const before = await accountBalance(page, "Carte de crédit")
  await importBankFile(page, "releve.qif", "Carte de crédit", { read: 1, toast: "1 opération importée" })
  expect(await accountBalance(page, "Carte de crédit")).toBe(before - 19_90)
  const rows = await searchRegister(page, "Carte de crédit", "Librairie du Port")
  await expect(rows).toContainText("−19,90 €")
  await expect(rows).toContainText("Roman")
})
