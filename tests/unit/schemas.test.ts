import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Days, Ids, MonthCount, Name, Notes } from "~/server/schemas"

const accepts = <S extends Schema.Top>(schema: S, value: unknown) => Schema.is(schema)(value)

describe("input bounds", () => {
  it("caps free text", () => {
    expect(accepts(Name, "Courses")).toBe(true)
    expect(accepts(Name, "x".repeat(201))).toBe(false)
    expect(accepts(Notes, "x".repeat(10_000))).toBe(true)
    expect(() => Schema.decodeUnknownSync(Name)("x".repeat(201))).toThrow(/trop long/)
  })

  it("caps periods and selections", () => {
    expect(accepts(Days, 7)).toBe(true)
    expect(accepts(Days, 100_000)).toBe(false)
    expect(accepts(MonthCount, 0)).toBe(false)
    expect(accepts(MonthCount, 24)).toBe(true)
    expect(accepts(Ids, Array.from({ length: 10_000 }, (_, i) => `id-${i}`))).toBe(true)
    expect(accepts(Ids, Array.from({ length: 100_001 }, () => "id"))).toBe(false)
  })
})
