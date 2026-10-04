import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { BundleStructure, Recurrence } from "~/server/schemas"

describe("Recurrence schema", () => {
  it("refuses a rhythm of zero, which would never move to the next occurrence", () => {
    expect(Schema.is(Recurrence)({ unit: "month", interval: 1 })).toBe(true)
    expect(Schema.is(Recurrence)({ unit: "month", interval: 0 })).toBe(false)
    expect(() => Schema.decodeUnknownSync(Recurrence)({ unit: "week", interval: 0 })).toThrow(/au moins 1/)
  })

  it("lets an import through so that the bad schedule alone is skipped", () => {
    const structure = {
      source: "runway",
      name: "Sauvegarde",
      accounts: [],
      groups: [],
      categories: [],
      payees: [],
      budgets: [],
      buffered: [],
      rules: [],
      schedules: [
        {
          id: "s",
          name: null,
          payeeId: null,
          accountId: "a",
          categoryId: null,
          amount: -100,
          recurrence: { unit: "month", interval: 0 },
          startDate: "2026-01-01",
          nextDate: "2026-01-01",
          endDate: null,
          autoPost: false,
          active: true,
        },
      ],
    }
    expect(Schema.is(BundleStructure)(structure)).toBe(true)
  })
})
