import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { open, waitForToast } from "./helpers"

test.describe.configure({ mode: "serial" })

const fixture = join(process.cwd(), "tests/fixtures/actual-fixture.zip")
const expected = JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/actual-expected.json"), "utf8")) as {
  accounts: Record<string, { balance: number; count: number }>
}
const euros = (c: number) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(c / 100).replace(/[  ]/g, " ").replace("-", "−")

test("replaces everything with an Actual export and reproduces its balances", async ({ page }) => {
  await open(page, "/settings/data")
  await page.getByTestId("import-file").setInputFiles(fixture)
  const dialog = page.getByRole("dialog")
  await expect(dialog).toContainText("Fichier Actual détecté")
  await expect(dialog).toContainText("Fixture Perso")
  await dialog.getByRole("radio", { name: "Tout remplacer" }).click()
  page.once("dialog", (d) => d.accept())
  await dialog.getByTestId("confirm-import").click()
  await waitForToast(page, "109 opérations importées")

  await open(page, "/accounts")
  const main = page.getByRole("main")
  await expect(main.getByText("Compte joint")).toHaveCount(0)
  for (const [name, account] of Object.entries(expected.accounts)) {
    const link = main.getByRole("link", { name: new RegExp(`^${name}`) })
    await expect(link).toContainText(`${account.count} opération`)
    await expect(link).toHaveText(new RegExp(euros(account.balance).replace(/\s/g, "\\s")))
  }
})

test("a second import in merge mode finds only duplicates", async ({ page }) => {
  await open(page, "/settings/data")
  await page.getByTestId("import-file").setInputFiles(fixture)
  const dialog = page.getByRole("dialog")
  await expect(dialog).toContainText(/109 opérations existent déjà/)
  await expect(dialog.getByTestId("confirm-import")).toHaveText("Importer 0 opération")
  await dialog.getByTestId("confirm-import").click()
  await waitForToast(page, "0 opération importée")
})

test("imported rules and schedules show up", async ({ page }) => {
  await open(page, "/settings/rules")
  await expect(page.getByTestId("rule-row")).toHaveCount(2)
  await open(page, "/schedules")
  await expect(page.getByTestId("schedule-row").filter({ hasText: "Netflix" })).toBeVisible()
})
