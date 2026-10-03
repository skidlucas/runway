// Builds tests/fixtures/actual-fixture.zip with the official Actual API, plus the values
// Actual itself computes (balances, budget months) in actual-expected.json. The import
// tests compare Runway's results against those numbers.
//
// Usage: node scripts/make-actual-fixture.mjs
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as api from "@actual-app/api"
import { zipSync } from "fflate"

const out = join(process.cwd(), "tests/fixtures")
mkdirSync(out, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), "actual-fixture-"))

let seed = 7
const rand = () => {
  seed = (seed * 16807) % 2147483647
  return (seed - 1) / 2147483646
}
const between = (a, b) => Math.round(a + rand() * (b - a))
const pad = (n) => String(n).padStart(2, "0")
const months = ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]

await api.init({ dataDir })
await api.runImport("Fixture Perso", async () => {
  const checking = await api.createAccount({ name: "Compte courant", offbudget: false }, 250000)
  const card = await api.createAccount({ name: "Carte de crédit", offbudget: false }, -12000)
  const savings = await api.createAccount({ name: "Livret A", offbudget: true }, 500000)
  const old = await api.createAccount({ name: "Ancien compte", offbudget: false }, 0)

  const groups = await api.getCategoryGroups()
  const income = groups.find((g) => g.is_income)
  const salaryCat = income.categories.find((c) => c.name === "Income").id

  const housing = await api.createCategoryGroup({ name: "Logement" })
  const daily = await api.createCategoryGroup({ name: "Quotidien" })
  const fun = await api.createCategoryGroup({ name: "Loisirs" })
  const cat = {}
  for (const [group, names] of [
    [housing, ["Loyer", "Énergie"]],
    [daily, ["Courses", "Transport", "Santé"]],
    [fun, ["Restaurants", "Abonnements", "Vieux loisir"]],
  ]) {
    for (const name of names) cat[name] = await api.createCategory({ name, group_id: group })
  }
  await api.updateCategory(cat["Vieux loisir"], { name: "Vieux loisir", hidden: true })

  for (const month of months) {
    await api.setBudgetAmount(month, cat.Loyer, 85000)
    await api.setBudgetAmount(month, cat["Énergie"], 6000)
    await api.setBudgetAmount(month, cat.Courses, 40000)
    await api.setBudgetAmount(month, cat.Transport, 8000)
    await api.setBudgetAmount(month, cat.Restaurants, 10000)
    await api.setBudgetAmount(month, cat.Abonnements, 3000)
  }
  // Overspending carried in the category from May on.
  await api.setBudgetCarryover("2026-05", cat.Transport, true)
  await api.holdBudgetForNextMonth("2026-06", 20000)

  const txs = []
  for (const month of months) {
    const d = (day) => `${month}-${pad(day)}`
    if (month === "2026-10") {
      txs.push({ date: d(1), amount: 260000, payee_name: "Employeur", category: salaryCat, imported_payee: "VIR SALAIRE EMPLOYEUR" })
      txs.push({ date: d(2), amount: -85000, payee_name: "Foncia", category: cat.Loyer })
      continue
    }
    txs.push({ date: d(1), amount: 260000, payee_name: "Employeur", category: salaryCat, imported_payee: "VIR SALAIRE EMPLOYEUR" })
    txs.push({ date: d(2), amount: -85000, payee_name: "Foncia", category: cat.Loyer, cleared: true })
    txs.push({ date: d(20), amount: -between(4000, 8000), payee_name: "EDF", category: cat["Énergie"] })
    txs.push({ date: d(28), amount: -1349, payee_name: "Netflix", category: cat.Abonnements })
    for (let i = 0; i < 6; i++) {
      txs.push({ date: d(between(3, 27)), amount: -between(1500, 9000), payee_name: i % 2 ? "Monoprix" : "Monop'", category: cat.Courses, imported_payee: "CB MONOP PARIS" })
    }
    txs.push({ date: d(between(3, 27)), amount: -between(5000, 14000), payee_name: "SNCF", category: cat.Transport })
    txs.push({ date: d(between(3, 27)), amount: -between(2000, 6000), payee_name: "Le Comptoir", category: cat.Restaurants, notes: "dîner" })
    txs.push({ date: d(between(3, 27)), amount: -between(500, 3000), payee_name: "Pharmacie" })
    txs.push({
      date: d(15),
      amount: -12000,
      payee_name: "Carrefour",
      subtransactions: [
        { amount: -8000, category: cat.Courses },
        { amount: -4000, category: cat["Santé"], notes: "parapharmacie" },
      ],
    })
  }
  await api.addTransactions(checking, txs)
  await api.addTransactions(card, [
    { date: "2026-04-10", amount: -4590, payee_name: "Amazon", category: cat["Vieux loisir"] },
    { date: "2026-06-11", amount: -2390, payee_name: "Le Comptoir", category: cat.Restaurants },
  ])

  const payees = await api.getPayees()
  const transferTo = (account) => payees.find((p) => p.transfer_acct === account).id
  await api.addTransactions(checking, [
    { date: "2026-05-05", amount: -30000, payee: transferTo(savings), category: null },
    { date: "2026-07-05", amount: -15000, payee: transferTo(card) },
  ], { runTransfers: true })

  // A deleted transaction leaves a tombstone row behind.
  const [toDelete] = await api.addTransactions(checking, [{ date: "2026-06-06", amount: -9999, payee_name: "Erreur" }], { learnCategories: false })
  const all = await api.getTransactions(checking, "2026-06-01", "2026-06-30")
  const err = all.find((t) => t.amount === -9999)
  if (err) await api.deleteTransaction(err.id)
  void toDelete

  // Two spellings of the same payee get merged: transactions keep the old id through payee_mapping.
  const after = await api.getPayees()
  const monop = after.find((p) => p.name === "Monop'")
  const monoprix = after.find((p) => p.name === "Monoprix")
  await api.mergePayees(monoprix.id, [monop.id])

  await api.createRule({
    stage: null,
    conditionsOp: "and",
    conditions: [{ field: "imported_payee", op: "contains", value: "MONOP" }],
    actions: [{ op: "set", field: "category", value: cat.Courses }],
  })
  await api.createRule({
    stage: null,
    conditionsOp: "and",
    conditions: [{ field: "payee", op: "is", value: monoprix.id }],
    actions: [{ op: "set", field: "category", value: cat.Courses }],
  })
  await api.createSchedule({
    name: "Netflix",
    payee: after.find((p) => p.name === "Netflix").id,
    account: checking,
    amount: -1349,
    amountOp: "is",
    date: { frequency: "monthly", start: "2026-10-28", interval: 1, endMode: "never" },
  })

  await api.closeAccount(old)
})

const budgets = await api.getBudgets()
const id = budgets[0].id
await api.loadBudget(id)
const accounts = await api.getAccounts()
const expected = { accounts: {}, months: {} }
for (const a of accounts) {
  const list = await api.getTransactions(a.id, "2000-01-01", "2100-01-01")
  expected.accounts[a.name] = {
    balance: list.reduce((s, t) => s + t.amount, 0),
    offBudget: !!a.offbudget,
    closed: !!a.closed,
    count: list.length,
  }
}
for (const month of months) {
  const m = await api.getBudgetMonth(month)
  const categories = {}
  for (const g of m.categoryGroups) {
    for (const c of g.categories) categories[c.name] = { budgeted: c.budgeted ?? 0, spent: c.spent ?? 0, balance: c.balance ?? 0 }
  }
  expected.months[month] = { toBudget: m.toBudget, totalIncome: m.totalIncome, totalBudgeted: m.totalBudgeted, categories }
}
await api.shutdown()

const dir = join(dataDir, readdirSync(dataDir).find((d) => d.startsWith("Fixture")))
const zip = zipSync({
  "db.sqlite": new Uint8Array(readFileSync(join(dir, "db.sqlite"))),
  "metadata.json": new Uint8Array(readFileSync(join(dir, "metadata.json"))),
})
writeFileSync(join(out, "actual-fixture.zip"), zip)
writeFileSync(join(out, "actual-expected.json"), JSON.stringify(expected, null, 2))
rmSync(dataDir, { recursive: true, force: true })
console.log("Wrote tests/fixtures/actual-fixture.zip and actual-expected.json")
