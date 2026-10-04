import { describe, expect, it } from "vitest"
import { isRunwayBackup } from "~/lib/runway-backup"

const lists = {
  accounts: [],
  groups: [],
  categories: [],
  payees: [],
  budgets: [],
  budgetMonths: [],
  rules: [],
  schedules: [],
  assets: [],
  valuations: [],
  savedViews: [],
  transactions: [],
}

describe("isRunwayBackup", () => {
  it("recognizes a backup, with or without dashboards", () => {
    expect(isRunwayBackup({ format: "runway-backup", version: 1, ...lists })).toBe(true)
    expect(isRunwayBackup({ format: "runway-backup", version: 1, ...lists, dashboards: [] })).toBe(true)
  })

  it("refuses a file that only claims to be one", () => {
    expect(isRunwayBackup({ format: "runway-backup" })).toBe(false)
    expect(isRunwayBackup({ format: "runway-backup", ...lists, transactions: undefined })).toBe(false)
    expect(isRunwayBackup({ format: "runway-backup", ...lists, dashboards: {} })).toBe(false)
    expect(isRunwayBackup({ ...lists })).toBe(false)
    expect(isRunwayBackup(null)).toBe(false)
  })
})
