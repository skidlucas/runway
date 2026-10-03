import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { AlertTriangle, ChevronLeft, ChevronRight, Eye, EyeOff, MoreHorizontal, Plus } from "lucide-react"
import * as React from "react"
import { ForecastChips } from "~/components/forecast-chips"
import { CategoryPicker } from "~/components/pickers"
import { PageHeader, useAppUi } from "~/components/shell"
import {
  AmountPill,
  Button,
  cx,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  Menu,
  Money,
  Popover,
  ProgressBar,
  SkeletonRows,
  Switch,
} from "~/components/ui"
import { addMonths, formatMonthLong, isMonth, monthOf } from "~/domain/dates"
import { formatMoney, parseAmount } from "~/domain/money"
import { localToday, useIsMobile } from "~/lib/hooks"
import { q, useAction } from "~/lib/queries"
import {
  createStarterCategories,
  fillBudget,
  moveBudget,
  setBudgetAmount,
  setBudgetCarryover,
} from "~/server/fns/core"
import { seedDemo } from "~/server/fns/data"
import type { BudgetCategoryRow, BudgetGroupRow, BudgetMonthDto } from "~/server/services/budget"

export const Route = createFileRoute("/_app/budget")({
  validateSearch: (search: Record<string, unknown>): { month?: string } =>
    typeof search.month === "string" && isMonth(search.month) ? { month: search.month } : {},
  loaderDeps: ({ search }) => ({ month: search.month }),
  loader: ({ context, deps }) =>
    Promise.all([
      context.queryClient.ensureQueryData(q.budget(deps.month ?? monthOf(localToday()))),
      context.queryClient.ensureQueryData(q.forecast()),
    ]),
  component: BudgetPage,
})

const GRID = "grid grid-cols-[minmax(0,1fr)_140px_140px_140px] max-lg:grid-cols-[minmax(0,1fr)_110px_110px_120px]"

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
      const el = e.target as HTMLElement
      if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
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
          <div className="grid grid-cols-3 border-b border-line max-md:hidden">
            <Kpi label="Revenus" value={data.income} />
            <Kpi label="Budgété" value={data.budgeted} />
            <Kpi label="Dépensé" value={data.spent} last />
          </div>
          {data.uncategorized.count > 0 ? (
            <Link
              to="/accounts/$accountId"
              params={{ accountId: "all" }}
              search={{ uncategorized: true }}
              className="flex items-center gap-2 border-b border-line bg-warning-soft px-5 py-2 text-warning"
            >
              <AlertTriangle size={14} />
              {data.uncategorized.count} opération{data.uncategorized.count > 1 ? "s" : ""} à catégoriser (
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

function Kpi({ label, value, last }: { label: string; value: number; last?: boolean }) {
  return (
    <div className={cx("flex flex-col gap-1 px-5 py-4", !last && "border-r border-line")}>
      <span className="text-[12px] text-faint">{label}</span>
      <Money value={value} className="text-[18px]" />
    </div>
  )
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
  const demo = useAction(seedDemo, { success: (r) => `Démo chargée : ${r.transactions} opérations` })
  return (
    <EmptyState
      title="Aucune catégorie pour l'instant. Pars d'un jeu de catégories types, ou importe ton budget Actual."
      action={
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => create.mutate(undefined)} loading={create.isPending}>
            Créer les catégories types
          </Button>
          <Link to="/settings/data">
            <Button>Importer depuis Actual</Button>
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
  const fill = useAction(fillBudget, { success: (n) => `${n} catégories mises à jour` })

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
              { separator: true },
              { label: "Tout remettre à zéro", danger: true, onSelect: () => fill.mutate({ data: { month, mode: { kind: "zero" } } }) },
            ]}
          />
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
  const ratio = category.budgeted > 0 ? category.spent / category.budgeted : 0
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
          className="invisible text-faint hover:text-fg group-hover:visible"
          aria-label={`Ajouter une opération dans ${category.name}`}
          onClick={() => openNewTransaction({ categoryId: category.id })}
        >
          <Plus size={13} />
        </button>
        {ratio > 0 ? <ProgressBar ratio={ratio} tone={ratio > 1 ? "negative" : "accent"} className="ml-auto mr-4 w-16 opacity-0 group-hover:opacity-100" /> : null}
      </span>
      <BudgetedCell category={category} month={month} editing={editing} onEdit={onEdit} />
      <span className="num text-right text-[12px] text-muted">{category.spent ? formatMoney(-category.spent) : formatMoney(0)}</span>
      <span className="flex justify-end">
        <AvailableMenu category={category} month={month} budget={budget} />
      </span>
    </div>
  )
}

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
  const save = useAction(setBudgetAmount)
  const [text, setText] = React.useState("")
  const [invalid, setInvalid] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (editing) {
      setText(category.budgeted ? (category.budgeted / 100).toFixed(2).replace(".", ",") : "")
      setInvalid(false)
      requestAnimationFrame(() => inputRef.current?.select())
    }
  }, [editing, category.budgeted])

  const commit = (then: boolean | "next" | "prev") => {
    const value = text.trim() === "" ? 0 : parseAmount(text)
    if (value === null) {
      setInvalid(true)
      return
    }
    if (value !== category.budgeted) save.mutate({ data: { month, categoryId: category.id, amount: value } })
    onEdit(then)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        aria-label={`Budget ${category.name}`}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setInvalid(false)
        }}
        onBlur={() => commit(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            commit("next")
          } else if (e.key === "Tab") {
            e.preventDefault()
            commit(e.shiftKey ? "prev" : "next")
          } else if (e.key === "Escape") {
            e.preventDefault()
            onEdit(false)
          }
        }}
        className={cx(
          "num h-7 w-full rounded-[6px] border bg-bg px-2 text-right text-[12px] outline-none",
          invalid ? "border-negative" : "border-accent-line",
        )}
      />
    )
  }
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

function AvailableMenu({ category, month, budget }: { category: BudgetCategoryRow; month: string; budget: BudgetMonthDto }) {
  const [open, setOpen] = React.useState(false)
  const [mode, setMode] = React.useState<"cover" | "transfer" | null>(null)
  const carry = useAction(setBudgetCarryover)
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
          {overspent ? (
            <MenuButton
              onClick={() => {
                setOpen(false)
                setMode("cover")
              }}
            >
              Couvrir le dépassement…
            </MenuButton>
          ) : null}
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
    ((mode === "cover" ? -category.available : category.available) / 100).toFixed(2).replace(".", ","),
  )
  const available = new Map(budget.groups.flatMap((g) => g.categories.map((c) => [c.id, c.available] as const)))
  const move = useAction(moveBudget, { success: "Budget mis à jour", onSuccess: onClose })
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
      title={mode === "cover" ? `Couvrir ${category.name}` : `Transférer depuis ${category.name}`}
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
        <Field label={mode === "cover" ? "Prendre dans" : "Vers"}>
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

function MobileBudget({ budget, month, showHidden }: { budget: BudgetMonthDto; month: string; showHidden: boolean }) {
  const [editing, setEditing] = React.useState<BudgetCategoryRow | null>(null)
  const groups = budget.groups.filter((g) => !g.isIncome && (showHidden || !g.hidden))
  return (
    <div className="flex flex-col">
      {groups.map((g) => (
        <section key={g.id} className="mt-3">
          <div className="flex justify-between px-5 py-1.5 text-[13px] text-muted">
            <span>{g.name}</span>
            <span className="num">{formatMoney(g.available)}</span>
          </div>
          {g.categories
            .filter((c) => showHidden || !c.hidden)
            .map((c) => {
              const ratio = c.budgeted > 0 ? c.spent / c.budgeted : c.spent > 0 ? 1.2 : 0
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setEditing(c)}
                  className="flex w-full flex-col gap-1.5 border-b border-line-subtle px-5 py-3 text-left"
                >
                  <span className="flex w-full items-center justify-between gap-3">
                    <span className="truncate">{c.name}</span>
                    <AmountPill value={c.available} className="text-[13px]" />
                  </span>
                  <ProgressBar ratio={ratio} tone={ratio > 1 ? "negative" : "accent"} />
                  <span className="num text-[12px] text-faint">
                    {formatMoney(c.spent)} sur {formatMoney(c.budgeted)}
                  </span>
                </button>
              )
            })}
        </section>
      ))}
      {editing ? <MobileBudgetDialog category={editing} month={month} onClose={() => setEditing(null)} /> : null}
    </div>
  )
}

function MobileBudgetDialog({ category, month, onClose }: { category: BudgetCategoryRow; month: string; onClose: () => void }) {
  const [text, setText] = React.useState(category.budgeted ? (category.budgeted / 100).toFixed(2).replace(".", ",") : "")
  const save = useAction(setBudgetAmount, { onSuccess: onClose })
  const value = text.trim() === "" ? 0 : parseAmount(text)
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={category.name}
      description={`Dépensé ${formatMoney(category.spent)} · moyenne 3 mois ${formatMoney(category.average3)}`}
      footer={
        <>
          <Button variant="ghost" onClick={() => setText((category.average3 / 100).toFixed(2).replace(".", ","))}>
            Moyenne
          </Button>
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
      <div className="px-5 py-4">
        <Field label="Budget du mois">
          <Input inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} className="num h-11 text-[18px]" autoFocus />
        </Field>
      </div>
    </Dialog>
  )
}
