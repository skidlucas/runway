import { expect, test as setup } from "@playwright/test"
import { E2E_PASSWORD, open } from "./helpers"

setup("logs in", async ({ page }) => {
  await open(page, "/budget")
  await expect(page).toHaveURL(/\/login/)

  await page.getByLabel("Mot de passe").fill("wrong")
  await page.getByRole("button", { name: "Entrer" }).click()
  await expect(page.getByText(/incorrect/i)).toBeVisible()

  await page.getByLabel("Mot de passe").fill(E2E_PASSWORD)
  await page.getByRole("button", { name: "Entrer" }).click()
  await expect(page).toHaveURL(/\/budget/)
  await page.context().storageState({ path: "e2e/.auth/state.json" })
})
