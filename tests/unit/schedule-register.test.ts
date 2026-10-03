import { describe, expect, it } from "vitest"
import { type Occurrence, registerRows } from "~/server/services/schedules"

const occurrence = (o: Partial<Occurrence> & Pick<Occurrence, "scheduleId" | "date">): Occurrence => ({
  transferAccountId: null,
  amount: -100,
  name: "Loyer",
  categoryId: "rent",
  accountId: "checking",
  overdue: false,
  ...o,
})

describe("schedule lines of a register", () => {
  const occurrences = [
    occurrence({ scheduleId: "rent", date: "2026-10-05" }),
    occurrence({ scheduleId: "weekly", date: "2026-10-04", amount: -20 }),
    occurrence({ scheduleId: "weekly", date: "2026-10-11", amount: -20 }),
    occurrence({ scheduleId: "savings", date: "2026-10-06", accountId: "checking", transferAccountId: "livret", categoryId: null }),
    occurrence({ scheduleId: "other", date: "2026-10-07", accountId: "card" }),
  ]

  it("lists the account's own schedules newest first, only the next one of each can be acted on", () => {
    const rows = registerRows(occurrences, "checking")
    expect(rows.map((r) => [r.scheduleId, r.date, r.next])).toEqual([
      ["weekly", "2026-10-11", false],
      ["savings", "2026-10-06", true],
      ["rent", "2026-10-05", true],
      ["weekly", "2026-10-04", true],
    ])
  })

  it("shows a transfer on the receiving account with money coming in", () => {
    const [row] = registerRows(occurrences, "livret")
    expect(row).toMatchObject({ scheduleId: "savings", amount: 100, accountId: "livret", transferAccountId: "checking", categoryId: null })
  })

  it("lists every schedule once, on its own account, for all accounts", () => {
    expect(registerRows(occurrences, null)).toHaveLength(occurrences.length)
  })
})
