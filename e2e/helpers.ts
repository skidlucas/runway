import { expect, type Locator, type Page } from "@playwright/test"
import { addDays, DEFAULT_TIME_ZONE, todayIn } from "../src/domain/dates"

export const E2E_PASSWORD = "e2e-password"

/** Waits until React has hydrated the server-rendered page (the root sets `data-hydrated`). */
export const hydrated = (page: Page) => expect(page.locator("html")).toHaveAttribute("data-hydrated", "true", { timeout: 30_000 })

/**
 * Navigates and waits for hydration: the dev server compiles each route on first visit, and an
 * interaction before React attaches its handlers would be lost.
 */
export const open = async (page: Page, path: string) => {
  await page.goto(path)
  await hydrated(page)
}

/** "1 457,50 €" / "−42,50 €" → cents. */
export const cents = (text: string) => {
  const cleaned = text.replace(/[\s  €]/g, "").replace("−", "-").replace(",", ".")
  return Math.round(Number(cleaned) * 100)
}

/** A whole amount as the app prints it, "1 457,50 €", "−42 €" or "+3,00 €", and nothing else. */
const AMOUNT = /^[+−-]?\d{1,3}([\s  ]\d{3})*(,\d\d)?[\s  ]€$/

/** The amount shown inside `scope` (a row, a card…), in cents. */
export const amountIn = async (scope: Locator) => cents(await scope.getByText(AMOUNT).first().innerText())

/** The browser runs on Europe/Paris (playwright.config.ts): days are computed there, not on the host clock. */
export const inDays = (n: number) => addDays(todayIn(DEFAULT_TIME_ZONE), n)

/** Several components render a desktop and a mobile variant: only one is visible. */
export const visible = (locator: Locator) => locator.locator("visible=true")

export const waitForToast = (page: Page, text: string | RegExp) => expect(page.getByRole("status").filter({ hasText: text })).toBeVisible()

export const pickInCommand = async (page: Page, trigger: Locator, query: string, option: string | RegExp) => {
  await trigger.click()
  await page.keyboard.type(query)
  await page.getByRole("option", { name: option }).click()
}

/** The register row of an account, from the accounts page. */
export const accountLink = (page: Page, name: string) =>
  page.getByRole("main").getByRole("link", { name: new RegExp(`^${name}\\s`) })

export const accountBalance = async (page: Page, name: string) => {
  await open(page, "/accounts")
  return amountIn(accountLink(page, name))
}

export const openAccount = async (page: Page, name: string) => {
  await open(page, "/accounts")
  await accountLink(page, name).click()
  await expect(page.getByRole("table", { name: "Opérations" }).or(page.getByText("Aucune opération sur ce compte."))).toBeVisible()
}
