import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { LoginGuard } from "~/server/services/login-guard"
import { createHarness, type Harness } from "./harness"

describe("LoginGuard", () => {
  let h: Harness
  beforeAll(async () => {
    h = await createHarness()
  }, 60_000)
  afterAll(() => h?.dispose())

  const attempt = (now: number) => h.run(LoginGuard.use((g) => g.attempt(now)))

  it("locks after ten attempts, even sent in parallel, then unlocks after 15 minutes", async () => {
    const now = 1_000_000
    const results = await h.run(
      Effect.all(
        Array.from({ length: 10 }, () => LoginGuard.use((g) => g.attempt(now))),
        { concurrency: "unbounded" },
      ),
    )
    expect(results.every((r) => r === null)).toBe(true)
    const locked = await attempt(now + 1)
    expect(locked).toBe(now + 1 + 15 * 60 * 1000)
    expect(await attempt(now + 60_000)).toBe(locked)
    expect(await attempt(locked! + 1)).toBeNull()
  })

  it("starts over after a successful login", async () => {
    await h.run(LoginGuard.use((g) => g.succeeded))
    for (let i = 0; i < 9; i++) await attempt(5_000_000)
    await h.run(LoginGuard.use((g) => g.succeeded))
    expect(await attempt(5_000_000)).toBeNull()
  })
})
