import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Db } from "~/server/db/client"
import { userMessageOf } from "~/server/errors"
import { createHarness, type Harness } from "./harness"

describe("A write pointing at a deleted row", () => {
  let h: Harness

  beforeAll(async () => {
    h = await createHarness()
  })
  afterAll(async () => {
    await h?.dispose()
  })

  it("tells the user to reload instead of an unexpected error", async () => {
    const error = await h.fail(
      Db.use((db) =>
        db.use((_, d1) =>
          d1
            .prepare("INSERT INTO transactions (id, account_id, date, amount) VALUES ('t', 'gone', '2026-01-01', 100)")
            .run(),
        ),
      ),
    )
    expect(userMessageOf(error)).toBe("Un élément lié a été supprimé entre-temps. Recharge la page et réessaie.")
  })

  it("leaves other database failures to the generic message", async () => {
    const error = await h.fail(Db.use((db) => db.use((_, d1) => d1.prepare("SELECT * FROM nowhere").all())))
    expect(userMessageOf(error)).toBeNull()
  })
})
