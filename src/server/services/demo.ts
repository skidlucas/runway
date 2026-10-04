import { Context, Effect, Layer } from "effect"
import { addMonths, type Day, daysInMonth, firstDay, monthOf, monthRange } from "~/domain/dates"
import { bulkInsertStatements, Db, type DbError, newId } from "../db/client"
import { Invalid, type NotFound } from "../errors"
import { Accounts } from "./accounts"
import { Categories } from "./categories"
import { Payees } from "./payees"
import { Schedules } from "./schedules"
import { Settings } from "./settings"
import { Transactions } from "./transactions"

// Deterministic pseudo-random generator so the demo data is the same on every run.
const mulberry32 = (seed: number) => () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const BUDGETS: Record<string, number> = {
  Loyer: 85000,
  Électricité: 6500,
  Internet: 3000,
  Courses: 42000,
  Transport: 9000,
  Santé: 4000,
  Restaurants: 12000,
  Sorties: 6000,
  Abonnements: 3500,
  Vacances: 25000,
  Imprévus: 50000,
}

export class Demo extends Context.Service<
  Demo,
  { readonly seed: Effect.Effect<{ transactions: number }, DbError | Invalid | NotFound> }
>()("runway/server/services/Demo") {
  static readonly layer = Layer.effect(
    Demo,
    Effect.gen(function* () {
      const db = yield* Db
      const settings = yield* Settings
      const categories = yield* Categories
      const accounts = yield* Accounts
      const payees = yield* Payees
      const schedules = yield* Schedules
      const transactions = yield* Transactions

      // The budget had no account before the seed: whatever hangs off an account is the demo's.
      // Without this, a seed failing halfway would leave accounts behind and the empty-budget
      // check would refuse every retry.
      const undo = db
        .batch(
          [
            "DELETE FROM transactions",
            "DELETE FROM schedules",
            "DELETE FROM payees WHERE transfer_account_id IS NOT NULL",
            "DELETE FROM accounts",
          ].map((sql) => db.d1.prepare(sql)),
        )
        .pipe(Effect.ignore({ log: "Warn", message: "Démo non nettoyée après un échec" }))

      const populate = Effect.gen(function* () {
        const today = yield* settings.today
        const currentMonth = monthOf(today)
        const firstMonth = addMonths(currentMonth, -12)

        yield* categories.createStarterSet
        const tree = yield* categories.tree
        const cat = (name: string) => tree.flatMap((g) => g.categories).find((c) => c.name === name)?.id ?? null
        const income = cat("Revenus")

        const checking = yield* accounts.create({
          name: "Compte courant",
          kind: "checking",
          offBudget: false,
          startingBalance: 180000,
          startingDate: firstDay(firstMonth),
        })
        const savings = yield* accounts.create({
          name: "Livret A",
          kind: "savings",
          offBudget: true,
          startingBalance: 650000,
          startingDate: firstDay(firstMonth),
        })

        const rand = mulberry32(42)
        const between = (min: number, max: number) => Math.round(min + rand() * (max - min))
        type Draft = { date: Day; amount: number; payee: string; category: string | null; notes?: string }
        const drafts: Draft[] = []
        for (const month of monthRange(firstMonth, currentMonth)) {
          const days = daysInMonth(month)
          const day = (d: number) => `${month}-${String(Math.min(d, days)).padStart(2, "0")}`
          const push = (d: number, amount: number, payee: string, category: string | null) => {
            const date = day(d)
            if (date <= today) drafts.push({ date, amount, payee, category })
          }
          push(1, 284000, "Employeur SAS", "Revenus")
          push(1, -85000, "Foncia", "Loyer")
          push(25, -between(4800, 7200), "EDF", "Électricité")
          push(5, -2999, "Free", "Internet")
          push(28, -1349, "Netflix", "Abonnements")
          push(12, -2199, "Canal+", "Abonnements")
          push(28, -8640, "Navigo", "Transport")
          for (let i = 0; i < 7; i++) push(between(1, days), -between(1500, 7800), ["Monoprix", "Picard", "Carrefour City"][i % 3]!, "Courses")
          for (let i = 0; i < 5; i++) push(between(1, days), -between(450, 4200), ["Le Comptoir", "Deliveroo", "Boulangerie Paul"][i % 3]!, "Restaurants")
          if (rand() > 0.4) push(between(1, days), -between(2500, 6500), "TotalEnergies", "Transport")
          if (rand() > 0.5) push(between(1, days), -between(1200, 4500), "Pharmacie du Centre", "Santé")
          if (rand() > 0.5) push(between(1, days), -between(1500, 4800), "UGC", "Sorties")
          // A summer trip makes the "Vacances" envelope useful.
          if (month.endsWith("-08")) push(10, -142000, "Airbnb", "Vacances")
        }

        const payeeIds = yield* payees.resolveNames([...new Set(drafts.map((d) => d.payee))])
        const rows = drafts.map((d) => [
          newId(),
          checking,
          d.date,
          d.amount,
          payeeIds.get(d.payee) ?? null,
          d.category === "Revenus" ? income : d.category ? cat(d.category) : null,
          d.date < today.slice(0, 8) + "01" ? 1 : 0,
        ])
        yield* db.batch(
          bulkInsertStatements(db.d1, "transactions", ["id", "account_id", "date", "amount", "payee_id", "category_id", "cleared"], rows),
        )
        const budgetRows = monthRange(firstMonth, currentMonth).flatMap((month) =>
          Object.entries(BUDGETS).flatMap(([name, amount]) => {
            const id = cat(name)
            return id ? [[month, id, amount]] : []
          }),
        )
        yield* db.batch(bulkInsertStatements(db.d1, "budgets", ["month", "category_id", "amount"], budgetRows, "replace"))
        for (const month of monthRange(firstMonth, currentMonth)) {
          // Put 500 € a month aside on the Livret A.
          const date = `${month}-03`
          if (date <= today) {
            yield* transactions.create({
              accountId: checking,
              date,
              amount: -50000,
              payee: { kind: "transfer", accountId: savings },
              categoryId: cat("Imprévus"),
              cleared: true,
            })
          }
        }

        const upcoming = [
          { name: "Assurance habitation", amount: -1850, day: 10, category: null },
          { name: "Spotify", amount: -1099, day: 15, category: null },
          { name: "Salle de sport", amount: -3490, day: 20, category: null },
        ] as const
        const nextDay = (d: number) => {
          const candidate = `${currentMonth}-${String(d).padStart(2, "0")}`
          return candidate >= today ? candidate : `${addMonths(currentMonth, 1)}-${String(d).padStart(2, "0")}`
        }
        for (const s of upcoming) {
          yield* schedules.create({
            name: s.name,
            payee: { kind: "name", name: s.name },
            accountId: checking,
            categoryId: s.category,
            amount: s.amount,
            recurrence: { unit: "month", interval: 1 },
            startDate: nextDay(s.day),
            autoPost: false,
          })
        }
        return { transactions: rows.length }
      }).pipe(Effect.onError(() => undo))

      const seed = Effect.gen(function* () {
        const existing = yield* accounts.list
        if (existing.length > 0) return yield* new Invalid({ message: "Les données de démo ne s'ajoutent qu'à un budget vide" })
        return yield* populate
      }).pipe(Effect.withSpan("Demo.seed"))

      return Demo.of({ seed })
    }),
  )
}
