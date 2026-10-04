import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { AlertTriangle, CalendarClock, ChevronLeft, ChevronRight, Eye, EyeOff, MoreHorizontal, Plus } from "lucide-react"
import * as React from "react"
import { ForecastChips } from "~/components/forecast-chips"
import { CategoryPicker } from "~/components/pickers"
import { PageHeader, useAppUi } from "~/components/shell"
import {
  AmountPill,
  Button,
  buttonClass,
  cx,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  Kpi,
  Menu,
  Money,
  Popover,
  revealOnHover,
  SkeletonRows,
  Switch,
} from "~/components/ui"
import { addMonths, formatDayLong, formatDayShort, formatMonthLong, isMonth, monthOf } from "~/domain/dates"
import { type PlannedCategory, type PlannedStatus, plannedStatus } from "~/domain/planned"
import { amountInput, formatMoney, parseAmount } from "~/domain/money"
import { localToday, shortcutBlocked, useIsMobile } from "~/lib/hooks"
import { BUDGET_QUERIES, defaultForecastAccount, forecastScope, q, useAction } from "~/lib/queries"
import {
  createStarterCategories,
  fillBudget,
  moveBudget,
  setBudgetAmount,
  setBudgetCarryover,
} from "~/server/fns/core"
import { seedDemo } from "~/server/fns/data"
import type { BudgetCategoryRow, BudgetGroupRow, BudgetMonthDto } from "~/server/services/budget"
import { count, plural } from "~/domain/text"

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

const GRID = "grid grid-cols-[minmax(0,1fr)_140px_140px_140px_140px] max-lg:grid-cols-[minmax(0,1fr)_100px_110px_110px_120px]"

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
        crumb={
          <span className="flex items-center gap-2.5">
            <IconButton label="Mois précédent" size="sm" onClick={() => goMonth(-1)}>
              <ChevronLeft size={15} />
            </IconButton>
            <span className="min-w-[118px] text-center" data-testid="budget-month">
              {formatMonthLong(month)}
            </span>
            <IconButton label="Mois suivant" size="sm" onClick={() => goMonth(1)}>
              <ChevronRight size={15} />
            </IconButton>
          </span>
        }
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
          <div className="grid grid-cols-4 border-b border-line max-md:hidden">
            <Kpi className={KPI_CELL} label="Revenus" value={<Money value={data.income} />} />
            <Kpi className={KPI_CELL} label="Budgété" value={<Money value={data.budgeted} />} />
            <Kpi className={KPI_CELL} label="Dépensé" value={<Money value={data.spent} />} />
            <Kpi
              className="px-5 py-4"
              label="Âge de l'argent"
              value={<AgeOfMoney month={month} testId="age-of-money" />}
            />
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
            <>
              <Kpi
                className="border-b border-line px-5 py-3"
                label="Âge de l'argent"
                value={<AgeOfMoney month={month} />}
                hint="Depuis combien de temps l'argent dépensé est arrivé, en moyenne"
              />
              <MobileBudget budget={data} month={month} showHidden={showHidden} />
            </>
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

function AgeOfMoney({ month, testId }: { month: string; testId?: string }) {
  const { data } = useQuery(q.ageOfMoney(month))
  return <span data-testid={testId}>{data === undefined ? "…" : data === null ? "—" : count(data, "jour")}</span>
}

function ToBudgetChip({ budget }: { budget: BudgetMonthDto }) {
  const negative = budget.toBudget < 0
  return (
    <Popover
      align="end"
      className="w-[300px] p-4"
      trigger={
        <button
          type="button"
          data-testid="to-budget"
          className={cx(
            "flex items-center gap-2.5 rounded-[6px] border py-[5px] pl-3 pr-2.5",
            negative ? "border-negative/40 bg-negative-soft" : "border-accent-line bg-accent-soft",
          )}
        >
          <span className={negative ? "text-negative" : "text-accent-fg"}>
            {negative ? "Trop budgété" : "À budgéter"}
          </span>
          <Money value={budget.toBudget} className="font-medium text-[var(--accent-strong-text)]" />
        </button>
      }
    >
      <div className="flex flex-col gap-2 text-[12px]">
        <Line label="Revenus du mois" value={budget.income} />
        <Line label="Reste du mois dernier" value={budget.fromLastMonth} />
        <Line label="Dépassements du mois dernier" value={budget.lastMonthOverspent} />
        <Line label="Budgété ce mois" value={-budget.budgeted} />
        {budget.buffered ? <Line label="Mis de côté pour le mois prochain" value={-budget.buffered} /> : null}
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
  const create = useAction(createStarterCategories, { success: "Catégories créées" })
  const demo = useAction(seedDemo, { success: (r) => `Démo chargée : ${count(r.transactions, "opération")}` })
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

// --- Desktop table ---------------------------------------------------------------

function BudgetTable({ budget, month, showHidden }: { budget: BudgetMonthDto; month: string; showHidden: boolean }) {
  const groups = budget.groups.filter((g) => showHidden || !g.hidden)
  const expenseGroups = groups.filter((g) => !g.isIncome)
  const incomeGroups = groups.filter((g) => g.isIncome)
  // Flat list of editable category ids, so Tab / Enter can move to the next row.
  const editable = expenseGroups.flatMap((g) => g.categories.filter((c) => showHidden || !c.hidden).map((c) => c.id))
  const [editing, setEditing] = React.useState<string | null>(null)
  const fill = useAction(fillBudget, { success: (n) => `${count(n, "catégorie")} ${plural(n, "mise")} à jour`, invalidates: BUDGET_QUERIES })

  return (
    <div role="table" aria-label="Budget du mois">
      <div role="row" className={cx(GRID, "h-[34px] items-center border-b border-line px-5 text-[12px] text-faint")}>
        <span role="columnheader" className="flex items-center gap-2">
          Catégorie
          <Menu
            align="start"
            trigger={
              <IconButton label="Remplir le budget" size="sm">
                <MoreHorizontal size={14} />
              </IconButton>
            }
            items={[
              { label: "Copier le budget du mois dernier", onSelect: () => fill.mutate({ data: { month, mode: { kind: "copyLastMonth" } } }) },
              { label: "Moyenne des 3 derniers mois", onSelect: () => fill.mutate({ data: { month, mode: { kind: "average", months: 3 } } }) },
              { label: "Moyenne des 6 derniers mois", onSelect: () => fill.mutate({ data: { month, mode: { kind: "average", months: 6 } } }) },
              { label: "Moyenne des 12 derniers mois", onSelect: () => fill.mutate({ data: { month, mode: { kind: "average", months: 12 } } }) },
              { label: "Budgéter ce qui a été dépensé", onSelect: () => fill.mutate({ data: { month, mode: { kind: "spent" } } }) },
              { label: "Budgéter les échéances", onSelect: () => fill.mutate({ data: { month, mode: { kind: "planned" } } }) },
              { separator: true },
              { label: "Tout remettre à zéro", danger: true, onSelect: () => fill.mutate({ data: { month, mode: { kind: "zero" } } }) },
            ]}
          />
        </span>
        <span role="columnheader" className="text-right">
          Prévu
        </span>
        <span role="columnheader" className="text-right">
          Budgété
        </span>
        <span role="columnheader" className="text-right">
          Dépensé
        </span>
        <span role="columnheader" className="text-right">
          Disponible
        </span>
      </div>
      {expenseGroups.map((g) => (
        <React.Fragment key={g.id}>
          <GroupRow group={g} />
          {g.categories
            .filter((c) => showHidden || !c.hidden)
            .map((c) => (
              <CategoryRow
                key={c.id}
                category={c}
                month={month}
                budget={budget}
                editing={editing === c.id}
                onEdit={(next) => {
                  if (next === "next" || next === "prev") {
                    const i = editable.indexOf(c.id)
                    setEditing(editable[next === "next" ? i + 1 : i - 1] ?? null)
                  } else setEditing(next ? c.id : null)
                }}
              />
            ))}
        </React.Fragment>
      ))}
      {incomeGroups.map((g) => (
        <React.Fragment key={g.id}>
          <div role="row" className={cx(GRID, "h-[34px] items-center border-b border-line-subtle bg-row-group px-5 font-medium text-fg-2")}>
            <span>{g.name}</span>
            <span />
            <span />
            <span className="num text-right text-[12px] text-muted">Reçu</span>
            <span className="num text-right text-[12px]">{formatMoney(g.spent)}</span>
          </div>
          {g.categories
            .filter((c) => showHidden || !c.hidden)
            .map((c) => (
              <div key={c.id} role="row" className={cx(GRID, "h-9 items-center border-b border-line-subtle pl-9 pr-5 hover:bg-hover")}>
                <CategoryLink category={c} month={month} />
                <span />
                <span />
                <span />
                <span className="num text-right text-[12px] text-positive">{formatMoney(c.spent)}</span>
              </div>
            ))}
        </React.Fragment>
      ))}
    </div>
  )
}

function GroupRow({ group }: { group: BudgetGroupRow }) {
  return (
    <div
      role="row"
      className={cx(GRID, "h-[34px] items-center border-b border-line-subtle bg-row-group px-5 font-medium text-fg-2")}
    >
      <span className="truncate">{group.name}</span>
      <span className="num text-right text-[12px] text-faint">{group.planned ? formatMoney(group.planned) : "—"}</span>
      <span className="num text-right text-[12px]">{formatMoney(group.budgeted)}</span>
      <span className="num text-right text-[12px] text-muted">{formatMoney(-group.spent)}</span>
      <span className="num text-right text-[12px]">{formatMoney(group.available)}</span>
    </div>
  )
}

function CategoryLink({ category, month }: { category: BudgetCategoryRow; month: string }) {
  return (
    <Link
      to="/accounts/$accountId"
      params={{ accountId: "all" }}
      search={{ categoryId: category.id, month }}
      className={cx("truncate hover:underline", category.hidden && "text-faint")}
    >
      {category.name}
    </Link>
  )
}

function CategoryRow({
  category,
  month,
  budget,
  editing,
  onEdit,
}: {
  category: BudgetCategoryRow
  month: string
  budget: BudgetMonthDto
  editing: boolean
  onEdit: (next: boolean | "next" | "prev") => void
}) {
  const { openNewTransaction } = useAppUi()
  return (
    <div
      role="row"
      data-testid={`category-row-${category.name}`}
      className={cx(GRID, "group h-9 items-center border-b border-line-subtle pl-9 pr-5 hover:bg-hover")}
    >
      <span className="flex min-w-0 items-center gap-2">
        <CategoryLink category={category} month={month} />
        {category.carryover ? (
          <span className="text-[11px] text-faint" title="Le dépassement est reporté sur le mois suivant">
            ↻
          </span>
        ) : null}
        <button
          type="button"
          className={cx("text-faint hover:text-fg", revealOnHover)}
          aria-label={`Ajouter une opération dans ${category.name}`}
          onClick={() => openNewTransaction({ categoryId: category.id })}
        >
          <Plus size={13} />
        </button>
      </span>
      <PlannedCell category={category} month={month} />
      <BudgetedCell category={category} month={month} editing={editing} onEdit={onEdit} />
      <span className="num text-right text-[12px] text-muted">{category.spent ? formatMoney(-category.spent) : formatMoney(0)}</span>
      <span className="flex justify-end">
        <AvailableMenu category={category} month={month} budget={budget} />
      </span>
    </div>
  )
}

const statusOf = (category: BudgetCategoryRow): PlannedStatus =>
  category.planned ? plannedStatus(category.planned, category.budgeted) : "covered"

const StatusIcon = ({ status, size }: { status: PlannedStatus; size: number }) =>
  status === "short" ? (
    <AlertTriangle size={size} className="shrink-0 text-warning" aria-label="Échéances du mois non couvertes" />
  ) : status === "upcoming" ? (
    <CalendarClock size={size} className="shrink-0 text-muted" aria-label="Échéances à venir à anticiper" />
  ) : null

function PlannedStatusNote({ category }: { category: BudgetCategoryRow }) {
  const planned = category.planned
  const status = statusOf(category)
  if (!planned || status === "covered") return null
  return (
    <p className={cx("mt-3 text-[12px]", status === "short" ? "text-warning" : "text-muted")}>
      {status === "short"
        ? `Il manque ${formatMoney(planned.thisMonth - planned.saved - category.budgeted)} pour les échéances de ce mois.`
        : `Ce mois-ci est couvert. ${formatMoney(planned.toBudget - category.budgeted)} de plus à mettre de côté pour les échéances à venir.`}
    </p>
  )
}

function PlannedCell({ category, month }: { category: BudgetCategoryRow; month: string }) {
  const [open, setOpen] = React.useState(false)
  const save = useAction(setBudgetAmount, { invalidates: BUDGET_QUERIES, onSuccess: () => setOpen(false) })
  const planned = category.planned
  if (!planned) return <span className="num text-right text-[12px] text-faint">—</span>
  const status = statusOf(category)
  return (
    <span className="flex justify-end">
      <Popover
        open={open}
        onOpenChange={setOpen}
        align="end"
        className="w-[340px] p-3"
        trigger={
          <button
            type="button"
            aria-label={`Prévu ${category.name} : ${formatMoney(planned.amount)}`}
            className={cx(
              "num -mr-2 flex h-7 items-center gap-1.5 rounded-[6px] px-2 text-[12px] hover:bg-active",
              status === "short" ? "text-warning" : "text-faint",
            )}
          >
            <StatusIcon status={status} size={12} />
            {formatMoney(planned.amount)}
          </button>
        }
      >
        <PlannedDetail planned={planned} />
        <PlannedStatusNote category={category} />
        {status === "covered" ? null : (
          <Button
            variant="primary"
            size="sm"
            className="mt-3 w-full"
            loading={save.isPending}
            onClick={() => save.mutate({ data: { month, categoryId: category.id, amount: planned.toBudget } })}
          >
            Budgéter {formatMoney(planned.toBudget)}
          </Button>
        )}
      </Popover>
    </span>
  )
}

function PlannedDetail({ planned }: { planned: PlannedCategory }) {
  const spaced = planned.lines.some((l) => l.kind === "setAside")
  return (
    <div className="flex flex-col gap-2 text-[12px]">
      {planned.lines.map((l) => (
        <div key={l.scheduleId} className="flex flex-col">
          <span className="flex items-baseline justify-between gap-3">
            <span className="truncate text-fg-2">{l.name}</span>
            <span className="num shrink-0">
              {l.count > 1 ? `${l.count} × ` : ""}
              {formatMoney(l.amount)}
            </span>
          </span>
          <span className="text-[11px] text-faint">
            {l.kind === "due"
              ? `${l.count > 1 ? "dès le" : "le"} ${formatDayShort(l.date)}`
              : `le ${formatDayLong(l.date)}${l.monthsLeft === 1 ? ", ce mois-ci" : `, lissé sur ${l.monthsLeft} mois`}`}
            {l.remaining ? ` · encore ${l.remaining.count} × ${formatMoney(l.amount)} jusqu'en ${formatMonthLong(monthOf(l.remaining.until)).toLowerCase()}` : ""}
          </span>
        </div>
      ))}
      <div className="mt-1 flex flex-col gap-1 border-t border-line pt-2">
        {planned.due && spaced ? <PlannedTotal label="À payer ce mois" value={planned.due} /> : null}
        {spaced ? (
          <PlannedTotal label={`À mettre de côté (déjà ${formatMoney(Math.max(0, planned.saved - planned.due))})`} value={planned.setAside} />
        ) : null}
        <PlannedTotal label="Prévu ce mois" value={planned.amount} strong />
        {planned.toBudget < planned.amount ? (
          <>
            <PlannedTotal label="Déjà dans l'enveloppe" value={planned.toBudget - planned.amount} />
            <PlannedTotal label="À budgéter ce mois" value={planned.toBudget} strong />
          </>
        ) : null}
      </div>
    </div>
  )
}

const PlannedTotal = ({ label, value, strong }: { label: string; value: number; strong?: boolean }) => (
  <span className={cx("flex justify-between gap-3", strong ? "font-medium text-fg" : "text-muted")}>
    <span>{label}</span>
    <span className="num">{formatMoney(value)}</span>
  </span>
)

function BudgetedCell({
  category,
  month,
  editing,
  onEdit,
}: {
  category: BudgetCategoryRow
  month: string
  editing: boolean
  onEdit: (next: boolean | "next" | "prev") => void
}) {
  const save = useAction(setBudgetAmount, { invalidates: BUDGET_QUERIES })
  if (editing)
    return (
      <BudgetInput
        category={category}
        onCommit={(amount, then) => {
          if (amount !== null && amount !== category.budgeted) save.mutate({ data: { month, categoryId: category.id, amount } })
          onEdit(then)
        }}
      />
    )
  return (
    <button
      type="button"
      onClick={() => onEdit(true)}
      onFocus={(e) => {
        // Keyboard users reach the cell with Tab: Enter starts editing.
        e.currentTarget.dataset.focused = "1"
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault()
          onEdit(true)
        }
      }}
      aria-label={`Budget ${category.name} : ${formatMoney(category.budgeted)}`}
      className="num -mr-2 h-7 rounded-[6px] px-2 text-right text-[12px] text-fg-2 hover:bg-active"
    >
      {formatMoney(category.budgeted)}
    </button>
  )
}

// Mounted per edit so the text starts from the stored amount and is fully selected:
// typing replaces it instead of appending to it.
function BudgetInput({
  category,
  onCommit,
}: {
  category: BudgetCategoryRow
  onCommit: (amount: number | null, then: boolean | "next" | "prev") => void
}) {
  const [text, setText] = React.useState(() => (category.budgeted ? amountInput(category.budgeted) : ""))
  const [invalid, setInvalid] = React.useState(false)
  // Leaving with Enter or Tab unmounts the input, which also fires blur.
  const done = React.useRef(false)

  const commit = (then: boolean | "next" | "prev") => {
    if (done.current) return
    const value = text.trim() === "" ? 0 : parseAmount(text)
    if (value === null) {
      setInvalid(true)
      return
    }
    done.current = true
    onCommit(value, then)
  }

  return (
    <input
      autoFocus
      aria-label={`Budget ${category.name}`}
      aria-invalid={invalid || undefined}
      value={text}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => {
        setText(e.target.value)
        setInvalid(false)
      }}
      onBlur={() => {
        if (done.current) return
        const value = text.trim() === "" ? 0 : parseAmount(text)
        done.current = true
        // An invalid amount is dropped on blur rather than trapping focus in the cell.
        onCommit(value, false)
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault()
          commit("next")
        } else if (e.key === "Tab") {
          e.preventDefault()
          commit(e.shiftKey ? "prev" : "next")
        } else if (e.key === "Escape") {
          e.preventDefault()
          done.current = true
          onCommit(null, false)
        }
      }}
      className={cx(
        "num h-7 w-full rounded-[6px] border bg-bg px-2 text-right text-[12px] outline-none",
        invalid ? "border-negative" : "border-accent-line",
      )}
    />
  )
}

function AvailableMenu({ category, month, budget }: { category: BudgetCategoryRow; month: string; budget: BudgetMonthDto }) {
  const [open, setOpen] = React.useState(false)
  const [mode, setMode] = React.useState<"cover" | "transfer" | null>(null)
  const carry = useAction(setBudgetCarryover, { invalidates: BUDGET_QUERIES })
  const overspent = category.available < 0
  return (
    <>
      <Popover
        open={open}
        onOpenChange={setOpen}
        align="end"
        className="w-[260px] p-1"
        trigger={
          <button type="button" aria-label={`Disponible ${category.name}`} className="rounded-[5px]">
            <AmountPill value={category.available} />
          </button>
        }
      >
        <div className="flex flex-col">
          <MenuButton
            onClick={() => {
              setOpen(false)
              setMode("cover")
            }}
          >
            {overspent ? "Couvrir le dépassement…" : "Prendre dans une autre catégorie…"}
          </MenuButton>
          {category.available > 0 ? (
            <MenuButton
              onClick={() => {
                setOpen(false)
                setMode("transfer")
              }}
            >
              Transférer vers une autre catégorie…
            </MenuButton>
          ) : null}
          <label className="flex items-center justify-between gap-3 rounded-[6px] px-2 py-1.5 text-fg-2">
            <span>
              Reporter le dépassement
              <span className="block text-[11px] text-faint">Sinon il est retiré du mois suivant</span>
            </span>
            <Switch
              checked={category.carryover}
              label="Reporter le dépassement"
              onCheckedChange={(checked) => carry.mutate({ data: { month, categoryId: category.id, carryover: checked } })}
            />
          </label>
          <div className="mt-1 border-t border-line px-2 pb-1 pt-2 text-[11px] text-faint">
            Reporté du mois dernier <span className="num">{formatMoney(category.carryIn)}</span> · moyenne 3 mois{" "}
            <span className="num">{formatMoney(category.average3)}</span>
          </div>
        </div>
      </Popover>
      {mode ? (
        <MoveMoneyDialog
          mode={mode}
          category={category}
          month={month}
          budget={budget}
          onClose={() => setMode(null)}
        />
      ) : null}
    </>
  )
}

const MenuButton = ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
  <button type="button" onClick={onClick} className="rounded-[6px] px-2 py-1.5 text-left text-fg-2 hover:bg-hover hover:text-fg">
    {children}
  </button>
)

function MoveMoneyDialog({
  mode,
  category,
  month,
  budget,
  onClose,
}: {
  mode: "cover" | "transfer"
  category: BudgetCategoryRow
  month: string
  budget: BudgetMonthDto
  onClose: () => void
}) {
  const [other, setOther] = React.useState<string | null>(null)
  const [amount, setAmount] = React.useState(
    mode === "cover" ? (category.available < 0 ? amountInput(-category.available) : "") : amountInput(category.available),
  )
  const available = new Map(budget.groups.flatMap((g) => g.categories.map((c) => [c.id, c.available] as const)))
  const move = useAction(moveBudget, { success: "Budget mis à jour", onSuccess: onClose, invalidates: BUDGET_QUERIES })
  const cents = parseAmount(amount)
  const fromToBudget = other === "__toBudget"
  const submit = () => {
    if (cents === null || cents <= 0 || !other) return
    const otherTarget = fromToBudget ? ({ kind: "toBudget" } as const) : ({ kind: "category", id: other } as const)
    const self = { kind: "category", id: category.id } as const
    move.mutate({
      data: {
        month,
        from: mode === "cover" ? otherTarget : self,
        to: mode === "cover" ? self : otherTarget,
        amount: cents,
      },
    })
  }
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={
        mode === "transfer" ? `Transférer depuis ${category.name}` : category.available < 0 ? `Couvrir ${category.name}` : `Alimenter ${category.name}`
      }
      width={420}
      footer={
        <>
          <span />
          <div className="flex gap-2">
            <Button onClick={onClose}>Annuler</Button>
            <Button variant="primary" onClick={submit} disabled={!other || cents === null || cents <= 0} loading={move.isPending}>
              Valider
            </Button>
          </div>
        </>
      }
    >
      <div className="flex flex-col gap-4 px-5 py-4">
        <Field label="Montant">
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} className="num" autoFocus />
        </Field>
        <Field label={mode === "cover" ? "Prendre dans" : "Vers"} group>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => setOther("__toBudget")}
              className={cx(
                "flex h-8 items-center justify-between rounded-[8px] border px-2.5",
                fromToBudget ? "border-accent-line bg-accent-soft" : "border-line-control",
              )}
            >
              <span>{mode === "cover" ? "À budgéter" : "Remettre dans « À budgéter »"}</span>
              <Money value={budget.toBudget} className="text-[12px] text-muted" />
            </button>
            <CategoryPicker
              value={fromToBudget ? null : other}
              onChange={setOther}
              exclude={[category.id]}
              available={available}
              allowNone={false}
              placeholder="Une catégorie"
            />
          </div>
        </Field>
      </div>
    </Dialog>
  )
}

// --- Mobile list -----------------------------------------------------------------

const MOBILE_GRID = "grid grid-cols-[minmax(0,1fr)_68px_68px_84px] gap-x-2 px-4 [&_.num]:whitespace-nowrap"

function MobileBudget({ budget, month, showHidden }: { budget: BudgetMonthDto; month: string; showHidden: boolean }) {
  const [editing, setEditing] = React.useState<BudgetCategoryRow | null>(null)
  const [moving, setMoving] = React.useState<{ category: BudgetCategoryRow; mode: "cover" | "transfer" } | null>(null)
  const groups = budget.groups.filter((g) => !g.isIncome && (showHidden || !g.hidden))
  return (
    <div className="flex flex-col">
      <div className={cx(MOBILE_GRID, "sticky top-0 z-10 border-b border-line bg-bg py-2 text-[11px] text-muted")}>
        <span>Catégorie</span>
        <span className="text-right">Budgété</span>
        <span className="text-right">Dépensé</span>
        <span className="text-right">Disponible</span>
      </div>
      {groups.map((g) => (
        <section key={g.id}>
          <div className={cx(MOBILE_GRID, "items-center border-b border-line-subtle bg-row-group py-2 text-[13px] font-medium text-fg-2")}>
            <span className="truncate">{g.name}</span>
            <span className="num text-right text-[12px]">{formatMoney(g.budgeted, { currency: false })}</span>
            <span className="num text-right text-[12px] text-muted">{formatMoney(-g.spent, { currency: false })}</span>
            <span className="num text-right text-[12px]">{formatMoney(g.available, { currency: false })}</span>
          </div>
          {g.categories
            .filter((c) => showHidden || !c.hidden)
            .map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setEditing(c)}
                className={cx(MOBILE_GRID, "min-h-12 w-full items-center border-b border-line-subtle py-2 text-left")}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="line-clamp-2 break-words text-[14px] leading-tight">{c.name}</span>
                  <StatusIcon status={statusOf(c)} size={13} />
                </span>
                <span className="num text-right text-[12px]">{formatMoney(c.budgeted, { currency: false })}</span>
                <span className="num text-right text-[12px] text-muted">{formatMoney(-c.spent, { currency: false })}</span>
                <span className="flex justify-end">
                  <AmountPill value={c.available} currency={false} />
                </span>
              </button>
            ))}
        </section>
      ))}
      {editing ? (
        <MobileBudgetDialog
          category={editing}
          month={month}
          onClose={() => setEditing(null)}
          onMove={(mode) => {
            setMoving({ category: editing, mode })
            setEditing(null)
          }}
        />
      ) : null}
      {moving ? (
        <MoveMoneyDialog mode={moving.mode} category={moving.category} month={month} budget={budget} onClose={() => setMoving(null)} />
      ) : null}
    </div>
  )
}

function MobileBudgetDialog({
  category,
  month,
  onClose,
  onMove,
}: {
  category: BudgetCategoryRow
  month: string
  onClose: () => void
  onMove: (mode: "cover" | "transfer") => void
}) {
  const [text, setText] = React.useState(category.budgeted ? amountInput(category.budgeted) : "")
  const save = useAction(setBudgetAmount, { onSuccess: onClose, invalidates: BUDGET_QUERIES })
  const value = text.trim() === "" ? 0 : parseAmount(text)
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={category.name}
      description={`Dépensé ${formatMoney(category.spent)} · moyenne 3 mois ${formatMoney(category.average3)}`}
      footer={
        <>
          <Button variant="ghost" onClick={() => setText(amountInput(category.average3))}>
            Moyenne
          </Button>
          {category.planned && statusOf(category) !== "covered" ? (
            <Button variant="ghost" onClick={() => setText(amountInput(category.planned?.toBudget ?? 0))}>
              Échéances
            </Button>
          ) : null}
          <Button
            variant="primary"
            disabled={value === null}
            loading={save.isPending}
            onClick={() => value !== null && save.mutate({ data: { month, categoryId: category.id, amount: value } })}
          >
            Enregistrer
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 px-5 py-4">
        {category.planned ? (
          <div>
            <PlannedDetail planned={category.planned} />
            <PlannedStatusNote category={category} />
          </div>
        ) : null}
        <Field label="Budget du mois">
          <Input inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} className="num h-11 text-[18px]" autoFocus />
        </Field>
        <div className="flex gap-2">
          <Button className="flex-1" onClick={() => onMove("cover")}>
            {category.available < 0 ? "Couvrir…" : "Prendre ailleurs…"}
          </Button>
          {category.available > 0 ? (
            <Button className="flex-1" onClick={() => onMove("transfer")}>
              Transférer…
            </Button>
          ) : null}
        </div>
      </div>
    </Dialog>
  )
}
