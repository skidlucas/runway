import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { addDays, addMonths, lastDay, monthRange, todayIn } from "~/domain/dates"
import { ExternalError } from "~/server/errors"
import { Accounts } from "~/server/services/accounts"
import { Settings } from "~/server/services/settings"
import { type AssetInput, Wealth } from "~/server/services/wealth"
import { createHarness, type Harness } from "./harness"

const today = todayIn("Europe/Paris")
const month = today.slice(0, 7)

const manual = (overrides: Partial<AssetInput> = {}): AssetInput => ({
  name: "Rolex Submariner",
  type: "watch",
  subtitle: null,
  purchase: { amount: 6_800_00, date: "2015-03-10" },
  declared: { amount: 9_500_00, date: `${addMonths(month, -2)}-12` },
  retained: "declared",
  source: { kind: "manual" },
  notes: null,
  ...overrides,
})

describe("Wealth", () => {
  let h: Harness
  const calls = { crypto: 0, quotes: 0, dvf: 0 }
  let historyCalls = 0
  beforeAll(async () => {
    h = await createHarness({
      market: {
        cryptoPrices: (ids) => {
          calls.crypto++
          return Effect.succeed(new Map(ids.filter((id) => id === "bitcoin").map((id) => [id, 60_000])))
        },
        quotes: (symbols) => {
          calls.quotes++
          return Effect.succeed(new Map(symbols.filter((s) => s === "CW8.PA").map((s) => [s, 500.5])))
        },
        // Daily prices for the last year: 40 000 € a year ago, +100 € per day.
        cryptoHistory: () => {
          historyCalls++
          return Effect.succeed(Array.from({ length: 366 }, (_, i) => ({ date: addDays(today, i - 365), price: 40_000 + i * 100 })))
        },
        dvfPricePerM2: (insee) => {
          calls.dvf++
          return insee === "69387"
            ? Effect.succeed({ pricePerM2: 4_800, sales: 1_200, from: "2025-01", to: "2025-12" })
            : Effect.fail(new ExternalError({ service: "DVF", message: "Pas assez de ventes" }))
        },
      },
    })
    await h.run(
      Accounts.use((a) =>
        a.create({ name: "Courant", kind: "checking", offBudget: false, startingBalance: 2_000_00, startingDate: `${addMonths(month, -14)}-01` }),
      ),
    )
  })
  afterAll(() => h?.dispose())

  it("lists budget accounts read-only and counts them in the net worth", async () => {
    const overview = await h.run(Wealth.use((w) => w.overview))
    expect(overview.items).toHaveLength(1)
    expect(overview.items[0]).toMatchObject({ kind: "account", name: "Courant", value: 2_000_00, bucket: "cash" })
    expect(overview.netWorth).toBe(2_000_00)
    expect(overview.history).toHaveLength(13)
    expect(overview.history.every((v) => v === 2_000_00)).toBe(true)
    expect(overview.needsRefresh).toBe(false)
  })

  it("uses the retained value and nets liabilities", async () => {
    const watch = await h.run(Wealth.use((w) => w.create(manual())))
    await h.run(
      Wealth.use((w) =>
        w.create(
          manual({
            name: "Crédit immo",
            type: "loan",
            purchase: null,
            declared: null,
            retained: "estimated",
            source: { kind: "loan", principal: 100_000_00, annualRatePct: 0, months: 100, startDate: `${addMonths(month, -10)}-01` },
          }),
        ),
      ),
    )
    const overview = await h.run(Wealth.use((w) => w.overview))
    const byName = new Map(overview.items.map((i) => [i.name, i]))
    expect(byName.get("Rolex Submariner")).toMatchObject({ value: 9_500_00, retainedUsed: "declared", bucket: "objects" })
    // 10 installments of 1 000 € paid on a zero-rate loan.
    expect(byName.get("Crédit immo")).toMatchObject({ value: -90_000_00, isLiability: true, bucket: "real_estate" })
    expect(byName.get("Crédit immo")!.estimate).toMatchObject({ label: "Tableau d'amortissement", automatic: true })
    expect(overview.netWorth).toBe(2_000_00 + 9_500_00 - 90_000_00)
    // The declared value only exists from two months ago: before that the purchase price counts.
    const watchHistory = byName.get("Rolex Submariner")!.history
    expect(watchHistory[0]).toBe(6_800_00)
    expect(watchHistory.at(-1)).toBe(9_500_00)

    await h.run(Wealth.use((w) => w.addValuation({ assetId: watch, date: today, amount: 10_200_00 })))
    await h.run(Wealth.use((w) => w.update(watch, manual({ retained: "estimated" }))))
    const after = await h.run(Wealth.use((w) => w.overview))
    expect(after.items.find((i) => i.id === watch)).toMatchObject({
      value: 10_200_00,
      estimate: { amount: 10_200_00, label: "Saisie manuelle", automatic: false },
    })
  })

  it("refreshes automatic estimates in one call per source", async () => {
    const btc = await h.run(
      Wealth.use((w) =>
        w.create(manual({ name: "Bitcoin", type: "crypto", purchase: null, declared: null, retained: "estimated", source: { kind: "crypto", coinId: "bitcoin", quantity: 0.5 } })),
      ),
    )
    expect(calls.crypto).toBe(1)
    await h.run(
      Wealth.use((w) =>
        Effect.all([
          w.create(manual({ name: "Ether", type: "crypto", purchase: null, declared: null, retained: "estimated", source: { kind: "crypto", coinId: "ethereum", quantity: 2 } })),
          w.create(manual({ name: "PEA", type: "investment", purchase: { amount: 31_000_00, date: null }, declared: null, retained: "estimated", source: { kind: "stock", symbol: "CW8.PA", quantity: 10 } })),
          w.create(manual({ name: "Appartement", type: "real_estate", purchase: { amount: 245_000_00, date: "2019-06-01" }, declared: null, retained: "estimated", source: { kind: "real_estate", inseeCode: "69387", surface: 62, propertyType: "apartment" } })),
          w.create(manual({ name: "Maison", type: "real_estate", purchase: { amount: 150_000_00, date: "2010-01-01" }, declared: null, retained: "estimated", source: { kind: "real_estate", inseeCode: "01001", surface: 90, propertyType: "house" } })),
        ]),
      ),
    )
    // Each creation priced its own asset; a forced refresh of everything batches by source.
    calls.crypto = 0
    calls.quotes = 0
    calls.dvf = 0
    const all = await h.run(Wealth.use((w) => w.overview))
    const ids = all.items.filter((i) => i.kind === "asset").map((i) => i.id)
    const result = await h.run(Wealth.use((w) => w.refresh({ ids })))
    expect(calls).toEqual({ crypto: 1, quotes: 1, dvf: 2 })
    expect(result.updated).toBe(3)
    expect(result.failures.map((f) => f.name).sort()).toEqual(["Ether", "Maison"])

    const overview = await h.run(Wealth.use((w) => w.overview))
    const byName = new Map(overview.items.map((i) => [i.name, i]))
    expect(byName.get("Bitcoin")).toMatchObject({ value: 30_000_00, estimate: { label: "Cours en direct", automatic: true, unitPrice: 60_000 } })
    expect(byName.get("PEA")!.value).toBe(5_005_00)
    expect(byName.get("Appartement")).toMatchObject({ value: 297_600_00, estimate: { label: "Estimation DVF", unitPrice: 4_800 } })
    // No estimate yet: falls back to the purchase price.
    expect(byName.get("Maison")).toMatchObject({ value: 150_000_00, retainedUsed: "purchase" })
    // The ones that failed are still due.
    expect(overview.needsRefresh).toBe(true)

    // Same day again: the automatic estimate is replaced, and the past is not fetched twice.
    expect(historyCalls).toBe(1)
    await h.run(Wealth.use((w) => w.refresh({ ids: [btc] })))
    expect(historyCalls).toBe(1)
    const valuations = await h.run(Wealth.use((w) => w.valuations(btc)))
    expect(valuations.filter((v) => v.date === today)).toHaveLength(1)
    // Backfilled: one automatic estimate per past month-end, from the price history.
    const monthEnds = monthRange(addMonths(month, -12), addMonths(month, -1)).map(lastDay)
    expect(valuations.map((v) => v.date)).toEqual([...monthEnds, today])
    const btcHistory = byName.get("Bitcoin")!.history
    expect(btcHistory[0]).toBeGreaterThan(20_000_00)
    expect(btcHistory[0]).toBeLessThan(btcHistory[11]!)
  })

  it("builds the history from month-end values", async () => {
    const id = await h.run(
      Wealth.use((w) => w.create(manual({ name: "Voiture", type: "vehicle", purchase: { amount: 20_000_00, date: `${addMonths(month, -6)}-15` }, declared: null, retained: "estimated" }))),
    )
    await h.run(Wealth.use((w) => w.addValuation({ assetId: id, date: lastDay(addMonths(month, -3)), amount: 18_000_00 })))
    const overview = await h.run(Wealth.use((w) => w.overview))
    const car = overview.items.find((i) => i.id === id)!
    expect(car.history.slice(0, 6).every((v) => v === 0)).toBe(true)
    expect(car.history[6]).toBe(20_000_00)
    expect(car.history[9]).toBe(18_000_00)
    expect(car.history[12]).toBe(18_000_00)
    expect(overview.history[12]).toBe(overview.netWorth)
    expect(overview.change).toEqual({
      amount: overview.netWorth - overview.history[0]!,
      ratio: (overview.netWorth - overview.history[0]!) / Math.abs(overview.history[0]!),
      since: overview.months[0],
    })
  })

  it("flags manual estimates older than six months", async () => {
    const id = await h.run(Wealth.use((w) => w.create(manual({ name: "Tableau", type: "art", retained: "estimated" }))))
    await h.run(Wealth.use((w) => w.addValuation({ assetId: id, date: `${addMonths(month, -8)}-01`, amount: 4_000_00 })))
    const overview = await h.run(Wealth.use((w) => w.overview))
    expect(overview.items.find((i) => i.id === id)?.stale).toBe(true)
  })

  it("rejects invalid input", async () => {
    await expect(h.run(Wealth.use((w) => w.create(manual({ name: " " }))))).rejects.toThrow(/nom/)
    await expect(h.run(Wealth.use((w) => w.create(manual({ type: "loan" }))))).rejects.toThrow(/capital/)
    await expect(
      h.run(Wealth.use((w) => w.create(manual({ type: "crypto", source: { kind: "crypto", coinId: "bitcoin", quantity: 0 } })))),
    ).rejects.toThrow(/quantité/)
    const tomorrow = await h.run(Settings.use((s) => s.today))
    const [first] = (await h.run(Wealth.use((w) => w.overview))).items.filter((i) => i.kind === "asset")
    await expect(
      h.run(Wealth.use((w) => w.addValuation({ assetId: first!.id, date: `${Number(tomorrow.slice(0, 4)) + 1}-01-01`, amount: 1 }))),
    ).rejects.toThrow(/futur/)
  })
})
