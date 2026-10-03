import { expect, type Locator, type Page } from "@playwright/test"

export const E2E_PASSWORD = "e2e-password"

/**
 * Navigates and waits for hydration: the dev server compiles each route on first visit, and an
 * interaction before React attaches its handlers would be lost.
 */
export const open = async (page: Page, path: string) => {
  await page.goto(path)
  await page.waitForLoadState("networkidle")
}

/** "1 457,50 €" / "−42,50 €" → cents. */
export const cents = (text: string) => {
  const cleaned = text.replace(/[\s  €]/g, "").replace("−", "-").replace(",", ".")
  return Math.round(Number(cleaned) * 100)
}

/** Several components render a desktop and a mobile variant: only one is visible. */
export const visible = (locator: Locator) => locator.locator("visible=true")

export const waitForToast = (page: Page, text: string | RegExp) => expect(page.getByRole("status").filter({ hasText: text })).toBeVisible()

export const pickInCommand = async (page: Page, trigger: Locator, query: string, option: string | RegExp) => {
  await trigger.click()
  await page.keyboard.type(query)
  await page.getByRole("option", { name: option }).click()
}
