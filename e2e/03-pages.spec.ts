import { expect, test } from "@playwright/test"
import { cents, open, visible } from "./helpers"

// The fixture's dates are fixed (March to October 2026): these checks hold whatever today is.

test("the forecast reconciles today's balance with the projection", async ({ page }) => {
  await open(page, "/forecast")
  const main = page.getByRole("main")
  await expect(main.getByText("Solde aujourd'hui")).toBeVisible()
  await expect(main.getByText(/Solde projeté au/)).toBeVisible()
  await expect(main.getByText("Solde projeté jour par jour")).toBeVisible()
  const projected = cents(await main.getByText(/Solde projeté au/).locator("..").innerText().then((t) => t.split("\n")[1] ?? ""))
  // The budget header shows the same end-of-month projection.
  await open(page, "/budget")
  await expect(page.getByTestId("chip-end-of-month")).toHaveText(/€/)
  expect(cents(await page.getByTestId("chip-end-of-month").innerText())).toBe(projected)
})

test("insights chart a year of spending and break it down by payee", async ({ page }) => {
  await open(page, "/insights")
  await expect(visible(page.getByTestId("insight-bar"))).toHaveCount(12)
  await expect(visible(page.getByText(/Par bénéficiaire/)).first()).toBeVisible()
  // No AI key in the e2e server: the page says how to enable the written analysis.
  await expect(visible(page.getByText(/OPENAI_API_KEY ou ANTHROPIC_API_KEY/)).first()).toBeVisible()
})

test("the command palette navigates", async ({ page }) => {
  await open(page, "/budget")
  await page.getByRole("button", { name: "Ouvrir la palette de commandes" }).click()
  await page.getByPlaceholder("Aller à, créer, chercher…").fill("Patrimoine")
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/\/wealth/)
})

test("the dashboard starts with default widgets and keeps the ones added", async ({ page }) => {
  await open(page, "/dashboard")
  const widgets = page.getByTestId("dashboard-widget")
  await expect(widgets).toHaveCount(6)
  await expect(page.getByRole("region", { name: "Total des comptes" })).toContainText("€")

  await page.getByRole("button", { name: "Modifier" }).click()
  await page.getByRole("button", { name: "Ajouter un widget" }).click()
  await page.getByRole("menuitem", { name: "Patrimoine net" }).click()
  await expect(widgets).toHaveCount(7)
  await expect(page.getByRole("region", { name: "Patrimoine net" })).toContainText("€")
  await page.getByRole("button", { name: "Terminer" }).click()

  await open(page, "/dashboard")
  await expect(widgets).toHaveCount(7)
  await page.getByRole("button", { name: "Modifier" }).click()
  await page.getByRole("button", { name: "Réglages de Patrimoine net" }).last().click()
  await page.getByRole("menuitem", { name: "Retirer" }).click()
  await expect(widgets).toHaveCount(6)
})

test("a saved view becomes a tab of the insights page", async ({ page }) => {
  await open(page, "/insights?months=6")
  await page.getByRole("button", { name: "Enregistrer la vue" }).click()
  const dialog = page.getByRole("dialog", { name: "Enregistrer la vue" })
  await dialog.getByLabel("Nom").fill("Six mois")
  await dialog.getByRole("button", { name: "Enregistrer", exact: true }).click()
  const tabs = page.getByRole("tablist", { name: "Vues enregistrées" })
  await expect(tabs.getByRole("tab", { name: "Six mois" })).toHaveAttribute("aria-selected", "true")
  await tabs.getByRole("tab", { name: "Exploration" }).click()
  await expect(page).not.toHaveURL(/months=6/)
  await tabs.getByRole("tab", { name: "Six mois" }).click()
  await expect(page).toHaveURL(/months=6/)
  await tabs.getByRole("button", { name: "Supprimer la vue Six mois" }).click()
  await expect(tabs).toHaveCount(0)
})
