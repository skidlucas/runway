import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { runBundleImport } from "~/lib/import-client"
import { backupToBundle, type RunwayBackup } from "~/lib/runway-backup"
import { Accounts } from "~/server/services/accounts"
import { Budget } from "~/server/services/budget"
import { Categories } from "~/server/services/categories"
import { Dashboards, DEFAULT_WIDGETS, MAIN_DASHBOARD_ID } from "~/server/services/dashboards"
import { Demo } from "~/server/services/demo"
import { ImportExport } from "~/server/services/import-export"
import { Insights } from "~/server/services/insights"
import { Payees } from "~/server/services/payees"
import { Rules } from "~/server/services/rules"
import { type ScheduleInput, Schedules } from "~/server/services/schedules"
import { Transactions } from "~/server/services/transactions"
import { Wealth } from "~/server/services/wealth"
import { createHarness, type Harness, importApi, tableCounts } from "./harness"

const NOW = "2026-10-04T10:00:00Z"
const include = { transactions: true, budgets: true, rules: true, schedules: true }

/** Restores a backup file the way the settings page does, through the server functions' validators. */
const restore = async (h: Harness, backup: RunwayBackup) => {
  const bundle = backupToBundle(JSON.parse(JSON.stringify(backup)))
  const api = importApi(h)
  const result = await runBundleImport(bundle, include, api)
  const extras = await api.importExtras({ extras: bundle.extras!, maps: result.maps })
  return { ...result, extras }
}

describe("Runway backup", () => {
  let source: Harness
  let target: Harness
  let backup: RunwayBackup
  let firstRestore: { assets: number; views: number }

  beforeAll(async () => {
    source = await createHarness({ now: NOW })
    target = await createHarness({ now: NOW })
    await source.run(Demo.use((d) => d.seed))
    const tree = await source.run(Categories.use((c) => c.tree))
    const group = tree.find((g) => g.categories.some((c) => c.name === "Courses"))!
    const courses = group.categories.find((c) => c.name === "Courses")!
    const monoprix = (await source.run(Payees.use((p) => p.resolveNames(["Monoprix"])))).get("Monoprix")
    await source.run(
      Insights.use((i) =>
        Effect.all([
          i.saveView("Courses", { measure: "expenses", target: { kind: "category", id: courses.id }, months: 12, rolling: 3 }),
          i.saveView("Groupe", { measure: "expenses", target: { kind: "group", id: group.id }, months: 6, rolling: 0 }),
          i.saveView("Monoprix", { measure: "expenses", target: { kind: "payee", id: monoprix! }, months: 12, rolling: 0 }),
          i.saveView("Tout", { measure: "income", target: { kind: "all" }, months: 12, rolling: 12 }),
        ]),
      ),
    )
    const watch = await source.run(
      Wealth.use((w) =>
        w.create({
          name: "Rolex",
          type: "watch",
          subtitle: null,
          purchase: { amount: 6_800_00, date: "2015-03-10" },
          declared: null,
          retained: "estimated",
          share: 5_000,
          source: { kind: "manual" },
          notes: "Boîte et papiers",
        }),
      ),
    )
    await source.run(Wealth.use((w) => w.addValuation({ assetId: watch, date: "2026-01-15", amount: 9_900_00 })))

    const meta = await source.run(ImportExport.use((s) => s.exportMeta))
    const transactions = await source.run(ImportExport.use((s) => s.exportTransactions(null, 20_000)))
    backup = { ...meta, format: "runway-backup", transactions }

    // Same categories and payee as the source, under other ids.
    await target.run(Categories.use((c) => c.createStarterSet))
    await target.run(Payees.use((p) => p.resolveNames(["Monoprix"])))
    firstRestore = (await restore(target, backup)).extras
  })
  afterAll(async () => {
    await source?.dispose()
    await target?.dispose()
  })

  it("restores assets, valuations and views, pointing views at the target's ids", async () => {
    expect(firstRestore).toEqual({ assets: 1, views: 4 })

    const wealth = await target.run(Wealth.use((w) => w.overview))
    expect(wealth.items.find((i) => i.name === "Rolex")).toMatchObject({ share: 5_000, value: 4_950_00, notes: "Boîte et papiers" })
    expect(wealth.netWorth).toBe((await source.run(Wealth.use((w) => w.overview))).netWorth)

    const tree = await target.run(Categories.use((c) => c.tree))
    const group = tree.find((g) => g.categories.some((c) => c.name === "Courses"))!
    const courses = group.categories.find((c) => c.name === "Courses")!
    const monoprix = (await target.run(Payees.use((p) => p.resolveNames(["Monoprix"])))).get("Monoprix")
    const views = new Map((await target.run(Insights.use((i) => i.savedViews))).map((v) => [v.name, v.config.target]))
    expect(views.get("Courses")).toEqual({ kind: "category", id: courses.id })
    expect(views.get("Groupe")).toEqual({ kind: "group", id: group.id })
    expect(views.get("Monoprix")).toEqual({ kind: "payee", id: monoprix })
    expect(views.get("Tout")).toEqual({ kind: "all" })
  })

  it("keeps a single copy of each asset, valuation and saved view when the same backup is restored again", async () => {
    const { extras } = await restore(target, backup)
    expect(extras.views).toBe(0)
    const wealth = await target.run(Wealth.use((w) => w.overview))
    expect(wealth.items.filter((i) => i.name === "Rolex")).toHaveLength(1)
    const watch = wealth.items.find((i) => i.name === "Rolex")!
    const { results: valuations } = await target.d1.prepare("SELECT id FROM asset_valuations WHERE asset_id = ?").bind(watch.id).all()
    expect(valuations).toHaveLength(1)
    expect(await target.run(Insights.use((i) => i.savedViews))).toHaveLength(4)
  })

  it("restores assets from older backups as wholly owned", async () => {
    const fresh = await createHarness({ now: NOW })
    try {
      await restore(fresh, { ...backup, assets: backup.assets.map(({ share: _, ...asset }) => asset) as RunwayBackup["assets"] })
      const wealth = await fresh.run(Wealth.use((w) => w.overview))
      expect(wealth.items.find((i) => i.name === "Rolex")).toMatchObject({ share: 10_000, value: 9_900_00 })
    } finally {
      await fresh.dispose()
    }
  })

  it("drops invalid widgets and keeps the default dashboard when restoring dashboards", async () => {
    const fresh = await createHarness({ now: NOW })
    try {
      const valid = { id: "ok", kind: "upcoming" as const, size: 1 as const, days: 7 }
      const invalid = { id: "ko", kind: "net_worth" as const, size: 2 as const, months: 7 }
      await restore(fresh, { ...backup, dashboards: [{ id: "perso", name: "Perso", widgets: [valid, invalid], sortOrder: 5 }] })
      const list = await fresh.run(Dashboards.use((d) => d.list))
      expect(list.map((d) => [d.id === MAIN_DASHBOARD_ID ? "main" : d.name, d.widgets])).toEqual([
        ["main", DEFAULT_WIDGETS],
        ["Perso", [valid]],
      ])
    } finally {
      await fresh.dispose()
    }
  })
})

describe("Runway backup settings", () => {
  it("brings back rule order and state, schedule links and account settings", async () => {
    const source = await createHarness({ now: NOW })
    const target = await createHarness({ now: NOW })
    try {
      const account = await source.run(
        Accounts.use((a) => a.create({ name: "Courant", kind: "checking", offBudget: false, startingBalance: 0, startingDate: "2026-01-01" })),
      )
      await source.d1.prepare("UPDATE accounts SET in_forecast = 0, in_net_worth = 0, last_reconciled_at = '2026-09-30' WHERE id = ?").bind(account).run()
      const [store] = await source.run(Payees.use((p) => p.resolveNames(["Amazon"]))).then((m) => [...m.values()])
      const rule = (value: string) =>
        source.run(
          Rules.use((r) =>
            r.create({ conditionsOp: "and", conditions: [{ field: "imported_payee", op: "contains", value }], actions: [{ type: "set_payee", payeeId: store! }] }),
          ),
        )
      const broad = await rule("amazon")
      const narrow = await rule("amazon prime")
      await source.run(Rules.use((r) => r.reorder([narrow.id, broad.id])))
      await source.d1.prepare("UPDATE rules SET enabled = 0 WHERE id = ?").bind(broad.id).run()
      const schedule = await source.run(
        Schedules.use((s) =>
          s.create({
            name: "Loyer",
            payee: { kind: "name", name: "Propriétaire" },
            accountId: account,
            categoryId: null,
            amount: -80_000,
            recurrence: { unit: "month", interval: 1 },
            startDate: "2026-09-05",
            autoPost: false,
          }),
        ),
      )
      await source.run(Schedules.use((s) => s.post(schedule, "2026-09-05")))

      const meta = await source.run(ImportExport.use((s) => s.exportMeta))
      const transactions = await source.run(ImportExport.use((s) => s.exportTransactions(null, 20_000)))
      await restore(target, { ...meta, format: "runway-backup", transactions })

      const rules = await target.run(Rules.use((r) => r.list))
      expect(rules.map((r) => [r.conditions[0]?.value, r.enabled])).toEqual([
        ["amazon prime", true],
        ["amazon", false],
      ])
      const booked = await target.d1.prepare("SELECT schedule_id AS s FROM transactions WHERE amount = -80000").first<{ s: string | null }>()
      expect(booked?.s).toBe(schedule)
      const restored = await target.d1
        .prepare("SELECT in_forecast AS f, in_net_worth AS w, last_reconciled_at AS r FROM accounts WHERE name = 'Courant'")
        .first<{ f: number; w: number; r: string | null }>()
      expect(restored).toEqual({ f: 0, w: 0, r: "2026-09-30" })
    } finally {
      await source.dispose()
      await target.dispose()
    }
  })
})

describe("Runway backup round trip", () => {
  let source: Harness
  let target: Harness
  let backup: RunwayBackup

  const snapshot = async (h: Harness) => {
    const meta = await h.run(ImportExport.use((s) => s.exportMeta))
    const transactions = await h.run(ImportExport.use((s) => s.exportTransactions(null, 20_000)))
    return { meta, transactions }
  }

  /** The exported data with every generated id replaced by the natural key of what it points at. */
  const normalize = ({ meta, transactions }: Awaited<ReturnType<typeof snapshot>>) => {
    const named = (map: Map<string, string>, id: string | null | undefined) => (id == null ? null : (map.get(id) ?? `inconnu:${id}`))
    const sorted = <T,>(rows: T[]) => rows.map((r) => JSON.stringify(r)).sort()
    const byOrder = <T extends { sortOrder: number }>(rows: T[]) => [...rows].sort((a, b) => a.sortOrder - b.sortOrder)
    const account = new Map(meta.accounts.map((a) => [a.id, a.name]))
    const group = new Map(meta.groups.map((g) => [g.id, g.name]))
    const category = new Map(meta.categories.map((c) => [c.id, `${group.get(c.groupId)}/${c.name}`]))
    const payee = new Map(meta.payees.map((p) => [p.id, p.transferAccountId ? `virement:${account.get(p.transferAccountId)}` : p.name]))
    const schedule = new Map(meta.schedules.map((s) => [s.id, s.name ?? ""]))
    const asset = new Map(meta.assets.map((a) => [a.id, a.name]))
    const view = new Map(meta.savedViews.map((v) => [v.id, v.name]))
    const tx = new Map(transactions.map((t) => [t.id, t]))
    const txKey = (id: string | null) => {
      const t = id ? tx.get(id) : undefined
      return t ? `${account.get(t.accountId)}|${t.date}|${t.amount}|${t.createdAt}` : id
    }
    return {
      transactionCount: meta.transactionCount,
      accounts: byOrder(meta.accounts).map(({ id: _, createdAt: _c, sortOrder: _s, ...a }) => a),
      groups: sorted(meta.groups.map(({ id: _, ...g }) => g)),
      categories: sorted(meta.categories.map(({ id: _, groupId, ...c }) => ({ ...c, group: group.get(groupId) }))),
      payees: sorted(meta.payees.map((p) => named(payee, p.id))),
      budgets: sorted(meta.budgets.map(({ categoryId, ...b }) => ({ ...b, category: named(category, categoryId) }))),
      budgetMonths: sorted(meta.budgetMonths),
      rules: byOrder(meta.rules).map(({ id: _, createdAt: _c, sortOrder: _s, ...r }) => ({
        ...r,
        conditions: r.conditions.map((c) => (c.field === "account" ? { ...c, value: named(account, String(c.value)) } : c)),
        actions: r.actions.map((a) =>
          a.type === "set_category"
            ? { ...a, categoryId: named(category, a.categoryId) }
            : a.type === "set_payee"
              ? { ...a, payeeId: named(payee, a.payeeId) }
              : a,
        ),
      })),
      schedules: sorted(
        // A schedule's creation time is not part of the backup.
        meta.schedules.map(({ id: _, payeeId, accountId, categoryId, createdAt: _c, ...s }) => ({
          ...s,
          payee: named(payee, payeeId),
          account: named(account, accountId),
          category: named(category, categoryId),
        })),
      ),
      assets: sorted(meta.assets.map(({ id: _, ...a }) => a)),
      valuations: sorted(meta.valuations.map(({ id: _, assetId, ...v }) => ({ ...v, asset: named(asset, assetId) }))),
      savedViews: byOrder(meta.savedViews).map(({ id: _, sortOrder: _s, config, ...v }) => ({
        ...v,
        config: {
          ...config,
          target:
            config.target.kind === "all"
              ? config.target
              : {
                  kind: config.target.kind,
                  id: named(config.target.kind === "category" ? category : config.target.kind === "group" ? group : payee, config.target.id),
                },
        },
      })),
      dashboards: byOrder(meta.dashboards ?? []).map(({ id: _, widgets, ...d }) => ({
        ...d,
        widgets: widgets.map((w) => (w.kind === "insight_view" ? { ...w, viewId: named(view, w.viewId) } : w)),
      })),
      transactions: sorted(
        transactions.map(({ id: _, accountId, payeeId, categoryId, transferId, parentId, scheduleId, ...t }) => ({
          ...t,
          account: named(account, accountId),
          payee: named(payee, payeeId),
          category: named(category, categoryId),
          transfer: txKey(transferId),
          parent: txKey(parentId),
          schedule: named(schedule, scheduleId),
        })),
      ),
    }
  }

  beforeAll(async () => {
    source = await createHarness({ now: NOW })
    target = await createHarness({ now: NOW })
    await source.run(Demo.use((d) => d.seed))
    const tree = await source.run(Categories.use((c) => c.tree))
    const cat = (name: string) => tree.flatMap((g) => g.categories).find((c) => c.name === name)!.id
    const accounts = await source.run(Accounts.use((a) => a.list))
    const checking = accounts.find((a) => a.name === "Compte courant")!.id
    const savings = accounts.find((a) => a.name === "Livret A")!.id

    // Hidden category, hidden group, carryover and money held for next month.
    await source.run(Categories.use((c) => c.update(cat("Sorties"), { hidden: true })))
    const archive = await source.run(Categories.use((c) => c.createGroup({ name: "Archives" })))
    const old = await source.run(Categories.use((c) => c.create({ groupId: archive.id, name: "Ancien loisir" })))
    await source.run(Categories.use((c) => c.updateGroup(archive.id, { hidden: true })))
    await source.run(Budget.use((b) => b.setAmount("2026-07", old.id, 2_500)))
    await source.run(Budget.use((b) => b.setCarryover("2026-08", cat("Courses"), true)))
    await source.d1.prepare("INSERT INTO budget_months (month, buffered) VALUES ('2026-09', 12345)").run()

    // A closed account with history, a second budget account and a transfer between the two.
    const joint = await source.run(
      Accounts.use((a) => a.create({ name: "Compte joint", kind: "checking", offBudget: false, startingBalance: 30_000, startingDate: "2026-01-01" })),
    )
    const closed = await source.run(
      Accounts.use((a) => a.create({ name: "Ancien livret", kind: "savings", offBudget: true, startingBalance: 5_000, startingDate: "2025-01-01" })),
    )
    await source.run(
      Transactions.use((t) => t.create({ accountId: closed, date: "2025-06-01", amount: -5_000, payee: { kind: "transfer", accountId: checking } })),
    )
    await source.run(Accounts.use((a) => a.setClosed(closed, true)))
    await source.run(
      Transactions.use((t) =>
        t.create({ accountId: checking, date: "2026-09-20", amount: -15_000, payee: { kind: "transfer", accountId: joint }, notes: "Courses du mois", cleared: true }),
      ),
    )
    // A split with notes on its lines, and a bank line with its raw label and bank id.
    await source.run(
      Transactions.use((t) =>
        t.create({
          accountId: checking,
          date: "2026-09-21",
          amount: -9_000,
          payee: { kind: "name", name: "Carrefour" },
          notes: "Plein et courses",
          splits: [
            { amount: -6_000, categoryId: cat("Courses"), notes: "Courses" },
            { amount: -3_000, categoryId: cat("Transport"), notes: null },
          ],
        }),
      ),
    )
    await source.run(
      ImportExport.use((s) =>
        s.importTransactions(
          [{ accountId: checking, date: "2026-09-22", amount: -4_200, payeeName: "Picard", importedPayee: "CB PICARD 22/09", importedId: "FITID-1", cleared: true }],
          { dedupe: true, applyRules: false },
        ),
      ),
    )
    // Cleared lines locked by a reconciliation.
    const cleared = (await source.run(Accounts.use((a) => a.list))).find((a) => a.id === checking)!.clearedBalance
    await source.run(Accounts.use((a) => a.reconcile(checking, cleared)))

    // Rules: on an account, renaming, disabled, in a custom order.
    const [picard] = await source.run(Payees.use((p) => p.resolveNames(["Picard"]))).then((m) => [...m.values()])
    const byAccount = await source.run(
      Rules.use((r) =>
        r.create({
          conditionsOp: "and",
          conditions: [
            { field: "account", op: "is", value: checking },
            { field: "imported_payee", op: "contains", value: "picard" },
          ],
          actions: [
            { type: "set_payee", payeeId: picard! },
            { type: "set_category", categoryId: cat("Courses") },
            { type: "set_notes", notes: "Surgelés" },
          ],
        }),
      ),
    )
    const disabled = await source.run(
      Rules.use((r) =>
        r.create({
          conditionsOp: "or",
          conditions: [{ field: "amount", op: "between", value: [1_000, 2_000] }],
          actions: [{ type: "set_category", categoryId: cat("Santé") }],
        }),
      ),
    )
    await source.run(Rules.use((r) => r.reorder([disabled.id, byAccount.id])))
    await source.d1.prepare("UPDATE rules SET enabled = 0 WHERE id = ?").bind(disabled.id).run()

    // Schedules: a transfer, one already booked, one that ended.
    const schedule = (input: Partial<ScheduleInput> & Pick<ScheduleInput, "name" | "payee" | "amount" | "startDate">) =>
      source.run(
        Schedules.use((s) => s.create({ accountId: checking, categoryId: null, recurrence: { unit: "month", interval: 1 }, autoPost: false, ...input })),
      )
    await schedule({ name: "Épargne", payee: { kind: "transfer", accountId: savings }, categoryId: cat("Imprévus"), amount: -10_000, startDate: "2026-10-20" })
    const booked = await schedule({
      name: "Mutuelle",
      payee: { kind: "name", name: "Mutuelle" },
      categoryId: cat("Santé"),
      amount: -4_500,
      recurrence: { unit: "month", interval: 2 },
      startDate: "2026-09-02",
      endDate: "2027-09-02",
    })
    await source.run(Schedules.use((s) => s.post(booked, "2026-09-02")))
    const ended = await schedule({ name: "Crédit auto", payee: { kind: "name", name: "Banque" }, amount: -20_000, startDate: "2026-07-05", endDate: "2026-08-05", autoPost: true })
    await source.run(Schedules.use((s) => s.sync))
    expect((await source.run(Schedules.use((s) => s.list))).find((s) => s.id === ended)?.active).toBe(false)

    // Wealth, saved views and dashboards.
    const watch = await source.run(
      Wealth.use((w) =>
        w.create({
          name: "Rolex",
          type: "watch",
          subtitle: "Submariner",
          purchase: { amount: 6_800_00, date: "2015-03-10" },
          declared: null,
          retained: "estimated",
          share: 5_000,
          source: { kind: "manual" },
          notes: "Boîte et papiers",
        }),
      ),
    )
    await source.run(Wealth.use((w) => w.addValuation({ assetId: watch, date: "2025-01-15", amount: 9_000_00 })))
    await source.run(Wealth.use((w) => w.addValuation({ assetId: watch, date: "2026-01-15", amount: 9_900_00 })))
    await source.run(
      Wealth.use((w) =>
        w.create({
          name: "Studio",
          type: "real_estate",
          subtitle: null,
          purchase: { amount: 150_000_00, date: "2020-06-01" },
          declared: { amount: 180_000_00, date: "2026-01-01" },
          retained: "declared",
          share: 10_000,
          source: { kind: "manual" },
          notes: null,
        }),
      ),
    )
    const daily = tree.find((g) => g.categories.some((c) => c.name === "Courses"))!
    const view = await source.run(
      Insights.use((i) => i.saveView("Courses", { measure: "expenses", target: { kind: "category", id: cat("Courses") }, months: 12, rolling: 3 })),
    )
    await source.run(Insights.use((i) => i.saveView("Groupe", { measure: "expenses", target: { kind: "group", id: daily.id }, months: 6, rolling: 0 })))
    await source.run(Insights.use((i) => i.saveView("Picard", { measure: "expenses", target: { kind: "payee", id: picard! }, months: 12, rolling: 0 })))
    const board = await source.run(Dashboards.use((d) => d.create("Perso")))
    await source.run(
      Dashboards.use((d) =>
        d.save(board.id, {
          widgets: [
            { id: "w1", kind: "insight_view", size: 2, viewId: view.id },
            { id: "w2", kind: "upcoming", size: 1, days: 7 },
          ],
        }),
      ),
    )
    await source.run(Dashboards.use((d) => d.save(MAIN_DASHBOARD_ID, { name: "Accueil" })))

    const exported = await snapshot(source)
    backup = { ...exported.meta, format: "runway-backup", transactions: exported.transactions }
    await restore(target, backup)
  }, 120_000)
  afterAll(async () => {
    await source?.dispose()
    await target?.dispose()
  })

  it("gives back the same data once restored into an empty budget and exported again", async () => {
    const before = normalize(await snapshot(source))
    // Every part of the backup must hold something, or comparing it proves nothing.
    for (const [key, value] of Object.entries(before)) {
      if (Array.isArray(value)) expect(value.length, key).toBeGreaterThan(0)
    }
    expect(normalize(await snapshot(target))).toEqual(before)
  })

  it("adds nothing when the same backup is restored again", async () => {
    const counts = await tableCounts(target.d1)
    expect(await restore(target, backup)).toMatchObject({ inserted: 0, extras: { assets: 2, views: 0 } })
    expect(await tableCounts(target.d1)).toEqual(counts)
  })
})
