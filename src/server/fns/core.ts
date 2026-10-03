import { createServerFn } from "@tanstack/react-start"
import { Effect, Schema } from "effect"
import { authMiddleware } from "../auth"
import { runApp } from "../runtime"
import { Accounts } from "../services/accounts"
import { Budget } from "../services/budget"
import { Categories } from "../services/categories"
import { Payees } from "../services/payees"
import { Rules } from "../services/rules"
import { Transactions } from "../services/transactions"

const v = Schema.toStandardSchemaV1

const Id = Schema.String
const Ids = Schema.Array(Schema.String)
const Cents = Schema.Int
const MonthS = Schema.String
const NullableId = Schema.NullOr(Schema.String)
const AccountKind = Schema.Literals(["checking", "savings", "credit", "investment", "other"])

// --- Accounts -------------------------------------------------------------------

export const getAccounts = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(() => runApp(Accounts.use((s) => s.list)))

export const createAccount = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    v(
      Schema.Struct({
        name: Schema.String,
        kind: AccountKind,
        offBudget: Schema.Boolean,
        startingBalance: Cents,
        startingDate: Schema.optional(Schema.String),
      }),
    ),
  )
  .handler(({ data }) => runApp(Accounts.use((s) => s.create(data))))

export const updateAccount = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    v(
      Schema.Struct({
        id: Id,
        name: Schema.optional(Schema.String),
        kind: Schema.optional(AccountKind),
        offBudget: Schema.optional(Schema.Boolean),
        inForecast: Schema.optional(Schema.Boolean),
      }),
    ),
  )
  .handler(({ data: { id, ...patch } }) => runApp(Accounts.use((s) => s.update(id, patch))))

export const setAccountClosed = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ id: Id, closed: Schema.Boolean })))
  .handler(({ data }) => runApp(Accounts.use((s) => s.setClosed(data.id, data.closed))))

export const deleteAccount = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ id: Id })))
  .handler(({ data }) => runApp(Accounts.use((s) => s.remove(data.id))))

export const reorderAccounts = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ ids: Ids })))
  .handler(({ data }) => runApp(Accounts.use((s) => s.reorder(data.ids))))

export const reconcileAccount = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ id: Id, statementBalance: Cents })))
  .handler(({ data }) => runApp(Accounts.use((s) => s.reconcile(data.id, data.statementBalance))))

// --- Categories -----------------------------------------------------------------

export const getCategories = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(() => runApp(Categories.use((s) => s.tree)))

export const createStarterCategories = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(() => runApp(Categories.use((s) => s.createStarterSet)))

export const createCategoryGroup = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ name: Schema.String, isIncome: Schema.optional(Schema.Boolean) })))
  .handler(({ data }) => runApp(Categories.use((s) => s.createGroup(data))))

export const updateCategoryGroup = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    v(Schema.Struct({ id: Id, name: Schema.optional(Schema.String), hidden: Schema.optional(Schema.Boolean) })),
  )
  .handler(({ data: { id, ...patch } }) => runApp(Categories.use((s) => s.updateGroup(id, patch))))

export const deleteCategoryGroup = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ id: Id, reassignTo: NullableId })))
  .handler(({ data }) => runApp(Categories.use((s) => s.deleteGroup(data.id, data.reassignTo))))

export const createCategory = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ groupId: Id, name: Schema.String })))
  .handler(({ data }) => runApp(Categories.use((s) => s.create(data))))

export const updateCategory = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    v(
      Schema.Struct({
        id: Id,
        name: Schema.optional(Schema.String),
        hidden: Schema.optional(Schema.Boolean),
        groupId: Schema.optional(Schema.String),
      }),
    ),
  )
  .handler(({ data: { id, ...patch } }) => runApp(Categories.use((s) => s.update(id, patch))))

export const deleteCategory = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ id: Id, reassignTo: NullableId })))
  .handler(({ data }) => runApp(Categories.use((s) => s.remove(data.id, data.reassignTo))))

export const reorderCategories = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ order: Schema.Array(Schema.Struct({ groupId: Id, categoryIds: Ids })) })))
  .handler(({ data }) => runApp(Categories.use((s) => s.reorder(data.order))))

// --- Payees ---------------------------------------------------------------------

export const getPayees = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(() => runApp(Payees.use((s) => s.list)))

export const renamePayee = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ id: Id, name: Schema.String })))
  .handler(({ data }) => runApp(Payees.use((s) => s.rename(data.id, data.name))))

export const mergePayees = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ sourceIds: Ids, targetId: Id })))
  .handler(({ data }) => runApp(Payees.use((s) => s.merge(data.sourceIds, data.targetId))))

export const deleteUnusedPayees = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(() => runApp(Payees.use((s) => s.deleteUnused)))

export const resolvePayee = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ name: Schema.String })))
  .handler(({ data }) =>
    runApp(Payees.use((s) => s.resolveNames([data.name])).pipe(Effect.map((ids) => ids.get(data.name) ?? ""))),
  )

export const suggestPayeeCategory = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ payeeId: Id })))
  .handler(({ data }) => runApp(Payees.use((s) => s.suggestCategory(data.payeeId))))

// --- Transactions ---------------------------------------------------------------

const PayeeInput = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("name"), name: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("id"), id: Id }),
  Schema.Struct({ kind: Schema.Literal("transfer"), accountId: Id }),
  Schema.Struct({ kind: Schema.Literal("none") }),
])

const SplitInput = Schema.Struct({
  amount: Cents,
  categoryId: NullableId,
  notes: Schema.optional(Schema.NullOr(Schema.String)),
})

export const listTransactions = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(
    v(
      Schema.Struct({
        accountId: Schema.optional(Schema.String),
        categoryId: Schema.optional(Schema.String),
        payeeId: Schema.optional(Schema.String),
        month: Schema.optional(Schema.String),
        from: Schema.optional(Schema.String),
        to: Schema.optional(Schema.String),
        search: Schema.optional(Schema.String),
        uncategorized: Schema.optional(Schema.Boolean),
        limit: Schema.optional(Schema.Int),
        offset: Schema.optional(Schema.Int),
      }),
    ),
  )
  .handler(({ data }) => runApp(Transactions.use((s) => s.list(data))))

export const createTransaction = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    v(
      Schema.Struct({
        accountId: Id,
        date: Schema.String,
        amount: Cents,
        payee: PayeeInput,
        categoryId: Schema.optional(NullableId),
        notes: Schema.optional(Schema.NullOr(Schema.String)),
        cleared: Schema.optional(Schema.Boolean),
        splits: Schema.optional(Schema.Array(SplitInput)),
      }),
    ),
  )
  .handler(({ data }) => runApp(Transactions.use((s) => s.create(data))))

export const updateTransaction = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    v(
      Schema.Struct({
        id: Id,
        accountId: Schema.optional(Id),
        date: Schema.optional(Schema.String),
        amount: Schema.optional(Cents),
        payee: Schema.optional(PayeeInput),
        categoryId: Schema.optional(NullableId),
        notes: Schema.optional(Schema.NullOr(Schema.String)),
        cleared: Schema.optional(Schema.Boolean),
        splits: Schema.optional(Schema.NullOr(Schema.Array(SplitInput))),
      }),
    ),
  )
  .handler(({ data: { id, ...patch } }) => runApp(Transactions.use((s) => s.update(id, patch))))

export const deleteTransactions = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ ids: Ids })))
  .handler(({ data }) => runApp(Transactions.use((s) => s.remove(data.ids))))

export const restoreTransactions = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ undoId: Schema.String })))
  .handler(({ data }) => runApp(Transactions.use((s) => s.restore(data.undoId))))

export const setTransactionsCleared = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ ids: Ids, cleared: Schema.Boolean })))
  .handler(({ data }) => runApp(Transactions.use((s) => s.setCleared(data.ids, data.cleared))))

export const setTransactionsCategory = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ ids: Ids, categoryId: NullableId })))
  .handler(({ data }) => runApp(Transactions.use((s) => s.setCategory(data.ids, data.categoryId))))

// --- Budget ---------------------------------------------------------------------

export const getBudgetMonth = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ month: MonthS })))
  .handler(({ data }) => runApp(Budget.use((s) => s.month(data.month))))

export const getAgeOfMoney = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ month: MonthS })))
  .handler(({ data }) => runApp(Budget.use((s) => s.ageOfMoney(data.month))))

export const setBudgetAmount = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ month: MonthS, categoryId: Id, amount: Cents })))
  .handler(({ data }) => runApp(Budget.use((s) => s.setAmount(data.month, data.categoryId, data.amount))))

export const setBudgetCarryover = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ month: MonthS, categoryId: Id, carryover: Schema.Boolean })))
  .handler(({ data }) => runApp(Budget.use((s) => s.setCarryover(data.month, data.categoryId, data.carryover))))

export const fillBudget = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    v(
      Schema.Struct({
        month: MonthS,
        mode: Schema.Union([
          Schema.Struct({ kind: Schema.Literal("copyLastMonth") }),
          Schema.Struct({ kind: Schema.Literal("average"), months: Schema.Int }),
          Schema.Struct({ kind: Schema.Literal("zero") }),
          Schema.Struct({ kind: Schema.Literal("spent") }),
        ]),
        categoryIds: Schema.optional(Ids),
      }),
    ),
  )
  .handler(({ data }) => runApp(Budget.use((s) => s.fill(data.month, data.mode, data.categoryIds))))

const MoveTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("category"), id: Id }),
  Schema.Struct({ kind: Schema.Literal("toBudget") }),
])

export const moveBudget = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ month: MonthS, from: MoveTarget, to: MoveTarget, amount: Cents })))
  .handler(({ data }) => runApp(Budget.use((s) => s.move(data.month, data.from, data.to, data.amount))))

export const setBudgetBuffered = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ month: MonthS, amount: Cents })))
  .handler(({ data }) => runApp(Budget.use((s) => s.setBuffered(data.month, data.amount))))

// --- Rules ----------------------------------------------------------------------

const RuleCondition = Schema.Struct({
  field: Schema.Literals(["payee", "imported_payee", "notes", "amount", "account"]),
  op: Schema.Literals(["is", "contains", "starts_with", "matches", "gt", "lt", "between"]),
  value: Schema.Union([Schema.String, Schema.Finite, Schema.Tuple([Schema.Finite, Schema.Finite])]),
})

const RuleAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("set_category"), categoryId: Id }),
  Schema.Struct({ type: Schema.Literal("set_payee"), payeeId: Id }),
  Schema.Struct({ type: Schema.Literal("set_notes"), notes: Schema.String }),
])

const RuleInput = Schema.Struct({
  conditionsOp: Schema.Literals(["and", "or"]),
  conditions: Schema.Array(RuleCondition),
  actions: Schema.Array(RuleAction),
  enabled: Schema.optional(Schema.Boolean),
  origin: Schema.optional(Schema.Literals(["manual", "suggested", "imported"])),
})

export const getRules = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(() => runApp(Rules.use((s) => s.list)))

export const createRule = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ rule: RuleInput, applyNow: Schema.optional(Schema.Boolean) })))
  .handler(({ data }) =>
    runApp(
      Effect.gen(function* () {
        const rules = yield* Rules
        const rule = yield* rules.create(data.rule)
        const applied = data.applyNow ? yield* rules.applyToUncategorized(rule.id) : 0
        return { rule, applied }
      }),
    ),
  )

export const updateRule = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ id: Id, rule: RuleInput })))
  .handler(({ data }) => runApp(Rules.use((s) => s.update(data.id, data.rule))))

export const deleteRule = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ id: Id })))
  .handler(({ data }) => runApp(Rules.use((s) => s.remove(data.id))))

export const reorderRules = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ ids: Ids })))
  .handler(({ data }) => runApp(Rules.use((s) => s.reorder(data.ids))))

export const applyRule = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ id: Id })))
  .handler(({ data }) => runApp(Rules.use((s) => s.applyToUncategorized(data.id))))

export const getRuleSuggestions = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(() => runApp(Rules.use((s) => s.suggestions)))
