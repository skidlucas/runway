import { readFile } from "node:fs/promises"
import { expect, type Page, test } from "@playwright/test"
import { open, visible, waitForToast } from "./helpers"

test.describe.configure({ mode: "serial" })

const accountBalances = async (page: Page) => {
  await open(page, "/accounts")
  return page.getByRole("main").getByRole("link").filter({ hasText: /€/ }).allInnerTexts()
}

const exportFile = async (page: Page, format: string) => {
  await open(page, "/settings/data")
  const download = page.waitForEvent("download")
  await page.getByRole("group", { name: format }).getByRole("button", { name: /^Exporter/ }).click()
  return (await download).path()
}

const replaceWith = async (page: Page, file: { name: string; mimeType: string; buffer: Buffer }) => {
  await open(page, "/settings/data")
  await page.getByTestId("import-file").setInputFiles(file)
  const dialog = page.getByRole("dialog")
  await dialog.getByRole("radio", { name: "Tout remplacer" }).click()
  await dialog.getByTestId("confirm-import").click()
  await page.getByTestId("confirm-dialog-confirm").click()
  await waitForToast(page, /importées?/)
}

test("a JSON backup restores accounts, wealth and saved views", async ({ page }) => {
  const balances = await accountBalances(page)
  await open(page, "/wealth")
  const netWorth = await visible(page.getByTestId("net-worth")).innerText()

  const path = await exportFile(page, "JSON complet")
  const buffer = await readFile(path)
  expect(JSON.parse(buffer.toString())).toMatchObject({ format: "runway-backup" })

  await open(page, "/settings/data")
  await page.getByTestId("import-file").setInputFiles({ name: "sauvegarde.json", mimeType: "application/json", buffer })
  const dialog = page.getByRole("dialog")
  await expect(dialog).toContainText("Sauvegarde Runway détectée")
  await expect(dialog).toContainText("Patrimoine et vues enregistrées")
  await dialog.getByRole("radio", { name: "Tout remplacer" }).click()
  await dialog.getByTestId("confirm-import").click()
  await page.getByTestId("confirm-dialog-confirm").click()
  await waitForToast(page, /importées?/)

  expect(await accountBalances(page)).toEqual(balances)
  await open(page, "/wealth")
  await expect(page.getByTestId("asset-row").filter({ hasText: "Rolex Submariner" })).toBeVisible()
  await expect(visible(page.getByTestId("net-worth"))).toHaveText(netWorth)
})

test("an Actual export re-imports with the same balances", async ({ page }) => {
  const balances = await accountBalances(page)
  const path = await exportFile(page, "Format Actual")
  await replaceWith(page, { name: "export.zip", mimeType: "application/zip", buffer: await readFile(path) })
  expect(await accountBalances(page)).toEqual(balances)
})
