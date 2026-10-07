import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { AlertTriangle, Eye, EyeOff } from "lucide-react"
import * as React from "react"
import { BudgetTable } from "~/components/budget/budget-table"
import { MobileBudget } from "~/components/budget/mobile-budget"
import { ForecastChips } from "~/components/forecast-chips"
import { PageHeader } from "~/components/shell"
import { Button, buttonClass, EmptyState, Kpi, Money, MonthStepper, Popover, SkeletonRows, StatChip } from "~/components/ui"
import { addMonths, isMonth, monthOf } from "~/domain/dates"
import { formatMoney } from "~/domain/money"
import { count } from "~/domain/text"
import { localToday, shortcutBlocked, useIsMobile } from "~/lib/hooks"
import { defaultForecastAccount, forecastScope, q, useAction } from "~/lib/queries"
import { createStarterCategories } from "~/server/fns/core"
import { seedDemo } from "~/server/fns/data"
import type { BudgetMonthDto } from "~/server/services/budget"

export const Route = createFileRoute("/_app/budget")({
  validateSearch: (search: Record<string, unknown>): { month?: string } =>
    typeof search.month === "string" && isMonth(search.month) ? { month: search.month } : {},
  loaderDeps: ({ search }) => ({ month: search.month }),
  loader: ({ context, deps }) =>
    Promise.all([
      context.queryClient.ensureQueryData(q.budget(deps.month ?? monthOf(localToday()))),
      context.queryClient
        .ensureQueryData(q.accounts())
        .then((accounts) => context.queryClient.ensureQueryData(q.forecast(forecastScope(defaultForecastAccount(accounts))))),
    ]),
  component: BudgetPage,
})


function BudgetPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: "/budget" })
  const month = search.month ?? monthOf(localToday())
  const budget = useQuery(q.budget(month))
  const [showHidden, setShowHidden] = React.useState(false)
  const mobile = useIsMobile()

  const goMonth = React.useCallback(
    (delta: number) => void navigate({ search: { month: addMonths(month, delta) } }),
    [month, navigate],
  )

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shortcutBlocked(e)) return
      if (e.key === "ArrowLeft") goMonth(-1)
      if (e.key === "ArrowRight") goMonth(1)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [goMonth])

  const data = budget.data
  const hasCategories = (data?.groups ?? []).some((g) => !g.isIncome && g.categories.length > 0)

  return (
    <>
      <PageHeader
        title="Budget"
        crumb={<MonthStepper month={month} onChange={(next) => void navigate({ search: { month: next } })} />}
        right={
          <>
            <ForecastChips />
            {data ? <ToBudgetChip budget={data} /> : null}
          </>
        }
      />

      {!data ? (
        <SkeletonRows rows={12} />
      ) : !hasCategories ? (
        <StarterEmptyState />
      ) : (
        <>
          <div className="grid grid-cols-3 border-b border-line max-md:hidden">
            <Kpi className={KPI_CELL} label="Revenus" value={<Money value={data.income} />} />
            <Kpi className={KPI_CELL} label="Budgété" value={<Money value={data.budgeted} />} />
            <Kpi className="px-5 py-4" label="Dépensé" value={<Money value={data.spent} />} />
          </div>
          {data.uncategorized.count > 0 ? (
            <Link
              to="/accounts/$accountId"
              params={{ accountId: "all" }}
              search={{ uncategorized: true, month }}
              className="flex items-center gap-2 border-b border-line bg-warning-soft px-5 py-2 text-warning"
            >
              <AlertTriangle size={14} />
              {count(data.uncategorized.count, "opération")} à catégoriser (
              {formatMoney(data.uncategorized.amount)}) · non comptées dans le budget
            </Link>
          ) : null}
          {mobile ? (
            <MobileBudget budget={data} month={month} showHidden={showHidden} />
          ) : (
            <BudgetTable budget={data} month={month} showHidden={showHidden} />
          )}
          <div className="flex items-center gap-2 px-5 py-4 text-muted">
            <Button
              variant="ghost"
              size="sm"
              icon={showHidden ? <EyeOff size={13} /> : <Eye size={13} />}
              onClick={() => setShowHidden((s) => !s)}
            >
              {showHidden ? "Masquer les catégories cachées" : "Afficher les catégories cachées"}
            </Button>
            <Link to="/settings/categories" className="ml-auto text-[12px] text-faint hover:text-fg">
              Gérer les catégories
            </Link>
          </div>
        </>
      )}
    </>
  )
}

const KPI_CELL = "border-r border-line px-5 py-4"

function ToBudgetChip({ budget }: { budget: BudgetMonthDto }) {
  const negative = budget.toBudget < 0
  return (
    <Popover
      align="end"
      className="w-[300px] p-4"
      trigger={
        <button type="button" data-testid="to-budget" className="rounded-[6px]">
          <StatChip tone={negative ? "negative" : "accent"} label={negative ? "Trop budgété" : "À budgéter"} value={<Money value={budget.toBudget} />} />
        </button>
      }
    >
      <div className="flex flex-col gap-2 text-[12px]">
        <Line label="Revenus du mois" value={budget.income} />
        <Line label="Reste du mois dernier" value={budget.fromLastMonth} />
        <Line label="Dépassements du mois dernier" value={budget.lastMonthOverspent} />
        <Line label="Budgété ce mois" value={-budget.budgeted} />
        {budget.buffered ? <Line label="Réservé pour le mois prochain" value={-budget.buffered} /> : null}
        <div className="my-1 h-px bg-line" />
        <Line label="À budgéter" value={budget.toBudget} strong />
      </div>
    </Popover>
  )
}

const Line = ({ label, value, strong }: { label: string; value: number; strong?: boolean }) => (
  <div className="flex justify-between gap-3">
    <span className={strong ? "font-medium text-fg" : "text-muted"}>{label}</span>
    <Money value={value} className={strong ? "font-medium" : ""} />
  </div>
)

function StarterEmptyState() {
  const create = useAction(createStarterCategories, { success: "Catégories créées", writes: ["categories"] })
  const demo = useAction(seedDemo, { success: (r) => `Démo chargée : ${count(r.transactions, "opération")}`, writes: ["everything"] })
  return (
    <EmptyState
      title="Aucune catégorie pour l'instant. Pars d'un jeu de catégories types, ou importe ton budget Actual."
      action={
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => create.mutate(undefined)} loading={create.isPending}>
            Créer les catégories types
          </Button>
          <Link to="/settings/data" className={buttonClass()}>
            Importer depuis Actual
          </Link>
          <Button variant="ghost" onClick={() => demo.mutate(undefined)} loading={demo.isPending}>
            Charger une démo
          </Button>
        </div>
      }
    />
  )
}
