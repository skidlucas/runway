import { asc, eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Db, type DbError, newId } from "../db/client"
import { type DashboardWidget, dashboards } from "../db/schema"
import { Invalid, NotFound } from "../errors"
import { REPORT_MONTHS, UPCOMING_DAYS } from "~/domain/reports"

export type DashboardDto = { id: string; name: string; widgets: DashboardWidget[] }

/** Shown while no dashboard is stored: it is written on its first change. */
export const MAIN_DASHBOARD_ID = "main"

export const DEFAULT_WIDGETS: DashboardWidget[] = [
  { id: "net-worth", kind: "net_worth", size: 2, months: 6 },
  { id: "cash-flow", kind: "cash_flow", size: 1, months: 1 },
  { id: "spending", kind: "spending_comparison", size: 1 },
  { id: "categories", kind: "category_spending", size: 1, months: 1 },
  { id: "upcoming", kind: "upcoming", size: 1, days: 7 },
  { id: "accounts", kind: "account_balances", size: 1 },
]

const MAX_WIDGETS = 30

const validWidget = (w: DashboardWidget) =>
  [1, 2, 3].includes(w.size) &&
  (w.months === undefined || (REPORT_MONTHS as ReadonlyArray<number>).includes(w.months)) &&
  (w.days === undefined || (UPCOMING_DAYS as ReadonlyArray<number>).includes(w.days)) &&
  (w.kind !== "insight_view" || typeof w.viewId === "string")

export class Dashboards extends Context.Service<
  Dashboards,
  {
    readonly list: Effect.Effect<DashboardDto[], DbError>
    create(name: string): Effect.Effect<DashboardDto, DbError | Invalid>
    /** Renames a dashboard and/or replaces its widgets (their order is the display order). */
    save(id: string, patch: { name?: string; widgets?: ReadonlyArray<DashboardWidget> }): Effect.Effect<void, DbError | Invalid | NotFound>
    remove(id: string): Effect.Effect<void, DbError>
  }
>()("runway/server/services/Dashboards") {
  static readonly layer = Layer.effect(
    Dashboards,
    Effect.gen(function* () {
      const db = yield* Db

      const list = db
        .use((orm) => orm.select().from(dashboards).orderBy(asc(dashboards.sortOrder), asc(dashboards.name)))
        .pipe(
          Effect.map((rows): DashboardDto[] =>
            rows.length === 0
              ? [{ id: MAIN_DASHBOARD_ID, name: "Principal", widgets: DEFAULT_WIDGETS }]
              : rows.map((r) => ({ id: r.id, name: r.name, widgets: r.widgets })),
          ),
        )

      const cleanName = (name: string) => {
        const trimmed = name.trim()
        return trimmed ? Effect.succeed(trimmed.slice(0, 60)) : Effect.fail(new Invalid({ message: "Donne un nom au tableau de bord" }))
      }

      const create = Effect.fn("Dashboards.create")(function* (name: string) {
        const trimmed = yield* cleanName(name)
        const id = newId()
        yield* db.use((orm) => orm.insert(dashboards).values({ id, name: trimmed, widgets: [], sortOrder: Date.now() }))
        return { id, name: trimmed, widgets: [] } satisfies DashboardDto
      })

      const save = Effect.fn("Dashboards.save")(function* (
        id: string,
        patch: { name?: string; widgets?: ReadonlyArray<DashboardWidget> },
      ) {
        const name = patch.name === undefined ? undefined : yield* cleanName(patch.name)
        const widgets = patch.widgets === undefined ? undefined : [...patch.widgets]
        if (widgets && (widgets.length > MAX_WIDGETS || !widgets.every(validWidget))) {
          return yield* new Invalid({ message: "Widget invalide" })
        }
        const current = yield* db.use((orm) => orm.select().from(dashboards).where(eq(dashboards.id, id)).get())
        if (!current) {
          if (id !== MAIN_DASHBOARD_ID) return yield* new NotFound({ entity: "Tableau de bord", id })
          yield* db.use((orm) =>
            orm
              .insert(dashboards)
              .values({ id, name: name ?? "Principal", widgets: widgets ?? DEFAULT_WIDGETS, sortOrder: 0 })
              .onConflictDoNothing(),
          )
          return
        }
        yield* db.use((orm) =>
          orm
            .update(dashboards)
            .set({ ...(name === undefined ? {} : { name }), ...(widgets === undefined ? {} : { widgets }) })
            .where(eq(dashboards.id, id)),
        )
      })

      const remove = (id: string) => db.use((orm) => orm.delete(dashboards).where(eq(dashboards.id, id))).pipe(Effect.asVoid)

      return Dashboards.of({ list, create, save, remove })
    }),
  )
}
