import { and, asc, eq, inArray, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Db, type DbError, newId } from "../db/client"
import { categories, categoryGroups, rules } from "../db/schema"
import { Invalid, NotFound } from "../errors"
import { Settings } from "./settings"

export type CategoryDto = {
  id: string
  groupId: string
  name: string
  isIncome: boolean
  hidden: boolean
  sortOrder: number
}

export type CategoryGroupDto = {
  id: string
  name: string
  isIncome: boolean
  hidden: boolean
  sortOrder: number
  categories: CategoryDto[]
}

export const STARTER_GROUPS: ReadonlyArray<{ name: string; categories: string[] }> = [
  { name: "Logement", categories: ["Loyer", "Électricité", "Internet"] },
  { name: "Quotidien", categories: ["Courses", "Transport", "Santé"] },
  { name: "Loisirs", categories: ["Restaurants", "Sorties", "Abonnements"] },
  { name: "Épargne", categories: ["Vacances", "Imprévus"] },
]

export class Categories extends Context.Service<
  Categories,
  {
    readonly tree: Effect.Effect<CategoryGroupDto[], DbError>
    createGroup(input: { name: string; isIncome?: boolean }): Effect.Effect<CategoryGroupDto, DbError | Invalid>
    updateGroup(id: string, patch: { name?: string; hidden?: boolean }): Effect.Effect<void, DbError | Invalid>
    deleteGroup(id: string, reassignTo: string | null): Effect.Effect<void, DbError | Invalid | NotFound>
    create(input: { groupId: string; name: string }): Effect.Effect<CategoryDto, DbError | Invalid | NotFound>
    update(id: string, patch: { name?: string; hidden?: boolean; groupId?: string }): Effect.Effect<void, DbError | Invalid | NotFound>
    /** Deletes a category, moving its transactions and budgets to `reassignTo` (or leaving them uncategorized). */
    remove(id: string, reassignTo: string | null): Effect.Effect<void, DbError | Invalid | NotFound>
    /** Persists a full ordering: groups in order, each with its categories in order. */
    reorder(order: ReadonlyArray<{ groupId: string; categoryIds: ReadonlyArray<string> }>): Effect.Effect<void, DbError>
    /** Income category that receives starting balances, created on first use. */
    readonly startingBalanceCategory: Effect.Effect<string, DbError>
    readonly createStarterSet: Effect.Effect<void, DbError>
  }
>()("runway/server/services/Categories") {
  static readonly layer = Layer.effect(
    Categories,
    Effect.gen(function* () {
      const db = yield* Db
      const settings = yield* Settings

      const tree = db
        .use(async (orm) => {
          const [groups, cats] = await Promise.all([
            orm.select().from(categoryGroups).orderBy(asc(categoryGroups.sortOrder), asc(categoryGroups.name)),
            orm.select().from(categories).orderBy(asc(categories.sortOrder), asc(categories.name)),
          ])
          return { groups, cats }
        })
        .pipe(
          Effect.map(({ groups, cats }) => {
            const byGroup = new Map<string, CategoryDto[]>()
            for (const c of cats) {
              const list = byGroup.get(c.groupId) ?? []
              list.push(c)
              byGroup.set(c.groupId, list)
            }
            // Income groups always come last, like in Actual.
            return groups
              .map((g) => ({ ...g, categories: byGroup.get(g.id) ?? [] }))
              .sort((a, b) => Number(a.isIncome) - Number(b.isIncome))
          }),
        )

      const nextGroupOrder = db.use((orm) =>
        orm
          .select({ max: sql<number>`coalesce(max(${categoryGroups.sortOrder}), 0)` })
          .from(categoryGroups)
          .get()
          .then((r) => (r?.max ?? 0) + 1),
      )

      const requireName = (name: string | undefined) => {
        const trimmed = name?.trim() ?? ""
        return trimmed === "" ? Effect.fail(new Invalid({ message: "Le nom est obligatoire" })) : Effect.succeed(trimmed)
      }

      const createGroup = Effect.fn("Categories.createGroup")(function* (input: { name: string; isIncome?: boolean }) {
        const name = yield* requireName(input.name)
        const sortOrder = yield* nextGroupOrder
        const row = { id: newId(), name, isIncome: input.isIncome ?? false, hidden: false, sortOrder }
        yield* db.use((orm) => orm.insert(categoryGroups).values(row))
        return { ...row, categories: [] }
      })

      const updateGroup = Effect.fn("Categories.updateGroup")(function* (
        id: string,
        patch: { name?: string; hidden?: boolean },
      ) {
        const values: Partial<typeof categoryGroups.$inferInsert> = {}
        if (patch.name !== undefined) values.name = yield* requireName(patch.name)
        if (patch.hidden !== undefined) values.hidden = patch.hidden
        if (Object.keys(values).length === 0) return
        yield* db.use((orm) => orm.update(categoryGroups).set(values).where(eq(categoryGroups.id, id)))
      })

      const findCategory = (id: string) =>
        db
          .use((orm) => orm.select().from(categories).where(eq(categories.id, id)).get())
          .pipe(Effect.flatMap((c) => (c ? Effect.succeed(c) : Effect.fail(new NotFound({ entity: "Catégorie", id })))))

      const create = Effect.fn("Categories.create")(function* (input: { groupId: string; name: string }) {
        const name = yield* requireName(input.name)
        const group = yield* db.use((orm) =>
          orm.select().from(categoryGroups).where(eq(categoryGroups.id, input.groupId)).get(),
        )
        if (!group) return yield* new NotFound({ entity: "Groupe", id: input.groupId })
        const max = yield* db.use((orm) =>
          orm
            .select({ max: sql<number>`coalesce(max(${categories.sortOrder}), 0)` })
            .from(categories)
            .where(eq(categories.groupId, group.id))
            .get(),
        )
        const row = {
          id: newId(),
          groupId: group.id,
          name,
          isIncome: group.isIncome,
          hidden: false,
          sortOrder: (max?.max ?? 0) + 1,
        }
        yield* db.use((orm) => orm.insert(categories).values(row))
        return row
      })

      const update = Effect.fn("Categories.update")(function* (
        id: string,
        patch: { name?: string; hidden?: boolean; groupId?: string },
      ) {
        yield* findCategory(id)
        const values: Partial<typeof categories.$inferInsert> = {}
        if (patch.name !== undefined) values.name = yield* requireName(patch.name)
        if (patch.hidden !== undefined) values.hidden = patch.hidden
        if (patch.groupId !== undefined) {
          const group = yield* db.use((orm) =>
            orm.select().from(categoryGroups).where(eq(categoryGroups.id, patch.groupId!)).get(),
          )
          if (!group) return yield* new NotFound({ entity: "Groupe", id: patch.groupId })
          values.groupId = group.id
          values.isIncome = group.isIncome
        }
        if (Object.keys(values).length === 0) return
        yield* db.use((orm) => orm.update(categories).set(values).where(eq(categories.id, id)))
      })

      // Moves everything that points at the given categories, then deletes them, in one D1 batch.
      const removeCategories = (ids: ReadonlyArray<string>, reassignTo: string | null) =>
        db.use(async (orm, d1) => {
          if (ids.length === 0) return
          const target = reassignTo ?? null
          const statements = []
          for (const id of ids) {
            statements.push(
              d1.prepare("UPDATE transactions SET category_id = ? WHERE category_id = ?").bind(target, id),
              d1.prepare("UPDATE schedules SET category_id = ? WHERE category_id = ?").bind(target, id),
            )
            if (target) {
              // Merge budgeted amounts into the target month by month.
              statements.push(
                d1
                  .prepare(
                    `INSERT INTO budgets (month, category_id, amount, carryover)
                     SELECT month, ?, amount, carryover FROM budgets WHERE category_id = ?
                     ON CONFLICT(month, category_id) DO UPDATE SET amount = budgets.amount + excluded.amount`,
                  )
                  .bind(target, id),
              )
            }
            statements.push(d1.prepare("DELETE FROM budgets WHERE category_id = ?").bind(id))
            statements.push(d1.prepare("DELETE FROM categories WHERE id = ?").bind(id))
          }
          await d1.batch(statements)
          // Rules that set a deleted category are rewritten or dropped.
          const allRules = await orm.select().from(rules)
          for (const rule of allRules) {
            const touches = rule.actions.some((a) => a.type === "set_category" && ids.includes(a.categoryId))
            if (!touches) continue
            const actions = rule.actions.flatMap((a) =>
              a.type === "set_category" && ids.includes(a.categoryId)
                ? target
                  ? [{ ...a, categoryId: target }]
                  : []
                : [a],
            )
            if (actions.length === 0) await orm.delete(rules).where(eq(rules.id, rule.id))
            else await orm.update(rules).set({ actions }).where(eq(rules.id, rule.id))
          }
        })

      const remove = Effect.fn("Categories.remove")(function* (id: string, reassignTo: string | null) {
        yield* findCategory(id)
        if (reassignTo === id) return yield* new Invalid({ message: "Choisis une autre catégorie" })
        if (reassignTo) yield* findCategory(reassignTo)
        yield* removeCategories([id], reassignTo)
      })

      const deleteGroup = Effect.fn("Categories.deleteGroup")(function* (id: string, reassignTo: string | null) {
        const group = yield* db.use((orm) => orm.select().from(categoryGroups).where(eq(categoryGroups.id, id)).get())
        if (!group) return yield* new NotFound({ entity: "Groupe", id })
        const cats = yield* db.use((orm) =>
          orm.select({ id: categories.id }).from(categories).where(eq(categories.groupId, id)),
        )
        if (reassignTo && cats.some((c) => c.id === reassignTo)) {
          return yield* new Invalid({ message: "La catégorie de remplacement appartient au groupe supprimé" })
        }
        yield* removeCategories(
          cats.map((c) => c.id),
          reassignTo,
        )
        yield* db.use((orm) => orm.delete(categoryGroups).where(eq(categoryGroups.id, id)))
      })

      const reorder = Effect.fn("Categories.reorder")(function* (
        order: ReadonlyArray<{ groupId: string; categoryIds: ReadonlyArray<string> }>,
      ) {
        yield* db.use(async (_, d1) => {
          const statements: D1PreparedStatement[] = []
          order.forEach((group, gi) => {
            statements.push(d1.prepare("UPDATE category_groups SET sort_order = ? WHERE id = ?").bind(gi + 1, group.groupId))
            group.categoryIds.forEach((cid, ci) => {
              statements.push(
                d1
                  .prepare(
                    "UPDATE categories SET sort_order = ?, group_id = ?, is_income = (SELECT is_income FROM category_groups WHERE id = ?) WHERE id = ?",
                  )
                  .bind(ci + 1, group.groupId, group.groupId, cid),
              )
            })
          })
          await d1.batch(statements)
        })
      })

      const startingBalanceCategory = Effect.gen(function* () {
        const existing = yield* settings.get("startingBalanceCategoryId")
        if (existing) {
          const found = yield* db.use((orm) => orm.select().from(categories).where(eq(categories.id, existing)).get())
          if (found) return found.id
        }
        let incomeGroup = yield* db.use((orm) =>
          orm.select().from(categoryGroups).where(eq(categoryGroups.isIncome, true)).get(),
        )
        if (!incomeGroup) {
          incomeGroup = { id: newId(), name: "Revenus", isIncome: true, hidden: false, sortOrder: 1000 }
          yield* db.use((orm) => orm.insert(categoryGroups).values(incomeGroup!))
          yield* db.use((orm) =>
            orm
              .insert(categories)
              .values({ id: newId(), groupId: incomeGroup!.id, name: "Revenus", isIncome: true, sortOrder: 1 }),
          )
        }
        const named = yield* db.use((orm) =>
          orm
            .select()
            .from(categories)
            .where(
              and(
                eq(categories.isIncome, true),
                inArray(categories.name, ["Soldes initiaux", "Starting Balances", "Solde initial"]),
              ),
            )
            .get(),
        )
        const id = named?.id ?? newId()
        if (!named) {
          yield* db.use((orm) =>
            orm
              .insert(categories)
              .values({ id, groupId: incomeGroup!.id, name: "Soldes initiaux", isIncome: true, sortOrder: 99 }),
          )
        }
        yield* settings.set("startingBalanceCategoryId", id)
        return id
      })

      const createStarterSet = Effect.gen(function* () {
        const existing = yield* db.use((orm) => orm.select({ id: categoryGroups.id }).from(categoryGroups).limit(1))
        if (existing.length > 0 && (yield* tree).some((g) => !g.isIncome)) return
        let order = 1
        const groupRows: (typeof categoryGroups.$inferInsert)[] = []
        const catRows: (typeof categories.$inferInsert)[] = []
        for (const g of STARTER_GROUPS) {
          const gid = newId()
          groupRows.push({ id: gid, name: g.name, isIncome: false, sortOrder: order++ })
          g.categories.forEach((name, i) => catRows.push({ id: newId(), groupId: gid, name, sortOrder: i + 1 }))
        }
        yield* db.use(async (orm) => {
          await orm.insert(categoryGroups).values(groupRows)
          await orm.insert(categories).values(catRows)
        })
        yield* startingBalanceCategory
      })

      return Categories.of({
        tree,
        createGroup,
        updateGroup,
        deleteGroup,
        create,
        update,
        remove,
        reorder,
        startingBalanceCategory,
        createStarterSet,
      })
    }),
  )
}
