import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { SessionEpoch } from "~/server/services/session-epoch"
import { Settings } from "~/server/services/settings"
import { createHarness, type Harness } from "./harness"

describe("SessionEpoch", () => {
  let h: Harness
  beforeAll(async () => {
    h = await createHarness()
  }, 60_000)
  afterAll(() => h?.dispose())

  it("starts at 0, so cookies issued before epochs existed stay valid, and goes up on each sign-out everywhere", async () => {
    expect(await h.run(SessionEpoch.use((s) => s.current))).toBe(0)
    expect(await h.run(SessionEpoch.use((s) => s.bump))).toBe(1)
    expect(await h.run(SessionEpoch.use((s) => s.bump))).toBe(2)
    expect(await h.run(SessionEpoch.use((s) => s.current))).toBe(2)
  })

  it("stays out of the user settings", async () => {
    expect(Object.keys(await h.run(Settings.use((s) => s.all)))).not.toContain("sessionEpoch")
  })
})
