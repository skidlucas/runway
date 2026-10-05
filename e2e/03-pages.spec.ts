import { expect, test } from "@playwright/test"
import { amountIn, cents, open, visible } from "./helpers"

// The fixture's dates are fixed (March to October 2026): these checks hold whatever today is.

test("the forecast reconciles today's balance with the projection", async ({ page }) => {
  await open(page, "/forecast")
  const main = page.getByRole("main")
  await expect(main.getByText("Solde aujourd'hui")).toBeVisible()
  await expect(main.getByText(/Solde projeté au/)).toBeVisible()
  await expect(main.getByText("Solde projeté jour par jour")).toBeVisible()
  const projected = await amountIn(main.getByRole("group", { name: /Solde projeté au/ }))
  // The budget header shows the same end-of-month projection.
  await open(page, "/budget")
  await expect(page.getByTestId("chip-end-of-month")).toHaveText(/€/)
  expect(cents(await page.getByTestId("chip-end-of-month").innerText())).toBe(projected)
})

test("the forecast opens on the first budget account, in the order set on the accounts page", async ({ page }) => {
  // The forecast's account tabs list the budget accounts in the accounts page order, then "Tous".
  await open(page, "/forecast")
  const tabs = page.getByRole("tablist", { name: "Compte" })
  const [first, second] = await tabs.getByRole("tab").allTextContents()
  expect(second).not.toBe("Tous")
  await expect(tabs.getByRole("tab", { name: first })).toHaveAttribute("aria-selected", "true")

  await open(page, "/accounts")
  const rows = page.getByRole("region", { name: "Budget", exact: true }).getByTestId("account-row")
  const row = (name: string) => rows.filter({ has: page.getByRole("link", { name: new RegExp(`^${name}\\s`) }) })
  await row(second!).getByRole("button", { name: "Monter" }).click()
  await expect(rows.first()).toContainText(second!)
  await open(page, "/forecast")
  await expect(tabs.getByRole("tab", { name: second })).toHaveAttribute("aria-selected", "true")

  await open(page, "/accounts")
  await row(second!).getByRole("button", { name: "Descendre" }).click()
  await expect(rows.first()).toContainText(first!)
})

test("insights chart a year of spending and break it down by payee", async ({ page }) => {
  await open(page, "/insights")
  const chart = visible(page.getByRole("img", { name: "Toutes les dépenses par mois" }))
  // The bars are plain SVG paths drawn by the chart library, with no role of their own.
  const bars = chart.locator(".ts-chart__bar-y path")
  await expect(bars).toHaveCount(12)
  await bars.last().hover()
  await expect(visible(page.getByRole("status").filter({ hasText: "Total" }))).toBeVisible()
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
  await page.getByTestId("confirm-dialog-confirm").click()
  await expect(tabs).toHaveCount(0)
})

test("a server call rejected for its input shows a generic message, without the server's details", async ({ page }) => {
  await open(page, "/budget")
  let body = ""
  await page.route(/\/_serverFn\//, async (route) => {
    const url = decodeURIComponent(route.request().url())
    if (route.request().method() !== "GET" || !/\d{4}-\d{2}/.test(url)) return route.continue()
    const tampered = new URL(route.request().url())
    tampered.search = new URLSearchParams(
      [...tampered.searchParams].map(([key, value]) => [key, value.replace(/\d{4}-\d{2}/g, "pas-un-mois")]),
    ).toString()
    const response = await route.fetch({ url: tampered.toString() })
    body = await response.text()
    await route.fulfill({ response, body })
  })
  await page.getByRole("button", { name: "Mois suivant" }).first().click()
  await expect(page.getByRole("status").filter({ hasText: "Une erreur inattendue est survenue" })).toBeVisible()
  expect(body).not.toMatch(/stack|Expected|issues|node_modules|\.ts:\d/)
})
