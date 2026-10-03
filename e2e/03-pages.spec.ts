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
