import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getToasts, holdToast, toast } from "~/components/toast"

describe("toast", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const last = () => getToasts().at(-1)!

  it("goes away after its duration", () => {
    toast("Enregistré", { duration: 1000 })
    const { id } = last()
    vi.advanceTimersByTime(1000)
    expect(getToasts().some((t) => t.id === id)).toBe(false)
  })

  it("keeps the rest of its time while held", () => {
    toast("Supprimée", { duration: 1000 })
    const { id } = last()
    vi.advanceTimersByTime(600)
    holdToast(id, true)
    vi.advanceTimersByTime(10_000)
    expect(getToasts().some((t) => t.id === id)).toBe(true)

    holdToast(id, false)
    vi.advanceTimersByTime(399)
    expect(getToasts().some((t) => t.id === id)).toBe(true)
    vi.advanceTimersByTime(1)
    expect(getToasts().some((t) => t.id === id)).toBe(false)
  })
})
