import { expect, test as setup } from "@playwright/test"
import { E2E_PASSWORD } from "./helpers"

setup("logs in", async ({ page }) => {
  await page.goto("/budget")
  await expect(page).toHaveURL(/\/login/)
  // The first load of a cold dev server is slow: typing before hydration would be lost.
  await page.waitForLoadState("networkidle")

  await page.getByLabel("Mot de passe").fill("wrong")
  await page.getByRole("button", { name: "Entrer" }).click()
  await expect(page.getByText(/incorrect/i)).toBeVisible()

  await page.getByLabel("Mot de passe").fill(E2E_PASSWORD)
  await page.getByRole("button", { name: "Entrer" }).click()
  await expect(page).toHaveURL(/\/budget/)
  await page.context().storageState({ path: "e2e/.auth/state.json" })
})
