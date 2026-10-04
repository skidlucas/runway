import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { MoreHorizontal, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react"
import * as React from "react"
import { AssetDialog } from "~/components/asset-dialog"
import { creditOf, DataCredit } from "~/components/data-credit"
import { PageHeader } from "~/components/shell"
import { toast } from "~/components/toast"
import { Button, Chip, cx, DateInput, EmptyState, heroAmountClass, IconButton, Input, Menu, Money, Sheet, SkeletonRows, Tabs, useConfirm } from "~/components/ui"
import { formatDayLong, formatDayShort, formatMonthLong, formatMonthShort, type Month } from "~/domain/dates"
import { formatMoney, formatPercent, parseAmount } from "~/domain/money"
import {
  type AllocationSlice,
  applyShare,
  type AssetType,
  assetTypeTotals,
  FULL_SHARE,
  formatShare,
  historyChange,
  loanEndMonth,
  loanMonthlyPayment,
  type RetainedKind,
  TYPE_LABELS,
  TYPE_ORDER,
  TYPE_PLURAL_LABELS,
  type WealthBucket,
  type WealthChange,
} from "~/domain/wealth"
import { localToday, useIsMobile } from "~/lib/hooks"
import { q, useAction } from "~/lib/queries"
import { addAssetValuation, deleteAsset, refreshValuations, updateAsset } from "~/server/fns/wealth"
import type { WealthItem, WealthOverview } from "~/server/services/wealth"
import { count, plural } from "~/domain/text"

/** `type` narrows the page to one kind of asset; `new` opens the dialog to add one. */
type Search = { type?: AssetType; new?: boolean }

const isAssetType = (v: unknown): v is AssetType => TYPE_ORDER.includes(v as AssetType)

export const Route = createFileRoute("/_app/wealth")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...(isAssetType(s.type) ? { type: s.type } : {}),
    ...(s.new ? { new: true } : {}),
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(q.wealth()),
  component: WealthPage,
})

const BUCKET_COLOR: Record<WealthBucket, string> = {
  real_estate: "var(--chart-1)",
  investments: "var(--chart-2)",
  crypto: "var(--chart-6)",
  objects: "var(--chart-3)",
  vehicles: "var(--chart-4)",
  cash: "var(--chart-5)",
}

const BUCKET_ORDER: WealthBucket[] = ["real_estate", "investments", "crypto", "vehicles", "objects", "cash"]

const RETAINED_LABEL: Record<RetainedKind, string> = { purchase: "achat", declared: "déclarée", estimated: "estimée" }

const euros = (cents: number) => formatMoney(cents, { decimals: 0 })

const sortItems = (items: ReadonlyArray<WealthItem>) =>
  [...items].sort(
    (a, b) =>
      BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket) ||
      Number(a.kind === "account") - Number(b.kind === "account") ||
      b.value - a.value,
  )

function WealthPage() {
  const wealth = useQuery(q.wealth())
  const search = Route.useSearch()
  const navigate = useNavigate({ from: "/wealth" })
  const mobile = useIsMobile()
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [dialog, setDialog] = React.useState<null | { item: WealthItem | null }>(null)
  const data = wealth.data
  const items = React.useMemo(() => sortItems(data?.items ?? []), [data])
  const type = mobile ? undefined : search.type
  const shown = type ? items.filter((i) => i.type === type) : items
  const selected = shown.find((i) => i.id === selectedId) ?? shown.find((i) => i.kind === "asset") ?? shown[0] ?? null
  const types = assetTypeTotals(items, { accounts: true })
  const credits = [...new Set(items.map((i) => creditOf(i.source)).filter((c) => c !== null))]
  const editing = dialog ?? (search.new ? { item: null } : null)

  const refresh = useAction(refreshValuations, { invalidates: ["wealth"] })
  // Automatic estimates are fetched lazily, once per visit, when some are out of date.
  const refreshed = React.useRef(false)
  React.useEffect(() => {
    if (data?.needsRefresh && !refreshed.current) {
      refreshed.current = true
      refresh.mutate({ data: {} })
    }
  }, [data?.needsRefresh, refresh])

  const refreshAll = () =>
    refresh.mutate(
      { data: { ids: items.filter((i) => i.source && isAutomaticSource(i)).map((i) => i.id) } },
      {
        onSuccess: (r) =>
          toast(
            r.failures.length === 0
              ? `${count(r.updated, "estimation")} ${plural(r.updated, "mise")} à jour`
              : `${r.updated} à jour · échec pour ${r.failures.map((f) => f.name).join(", ")} : ${r.failures[0]!.message}`,
            { duration: r.failures.length ? 7000 : 3500 },
          ),
      },
    )

  return (
    <>
      <PageHeader
        title="Patrimoine"
        right={
          <>
            <Button
              variant="ghost"
              icon={<RefreshCw size={14} className={cx(refresh.isPending && "animate-spin")} />}
              onClick={refreshAll}
              disabled={refresh.isPending}
              className="max-md:hidden"
            >
              Mettre à jour
            </Button>
            <Button icon={<Plus size={14} />} onClick={() => setDialog({ item: null })} className="max-md:ml-auto">
              Ajouter un bien
            </Button>
          </>
        }
      />
      {!data ? (
        <SkeletonRows rows={10} height={46} />
      ) : mobile ? (
        <MobileWealth data={data} items={items} onOpen={(i) => setSelectedId(i.id)} openId={selectedId} onClose={() => setSelectedId(null)} onEdit={(item) => setDialog({ item })} />
      ) : (
        <div className="grid min-h-[calc(100vh-48px)] grid-cols-[minmax(0,1fr)_340px] max-[1100px]:grid-cols-1">
          <div className="flex min-w-0 flex-col border-r border-line max-[1100px]:border-r-0">
            {types.length > 0 ? (
              <Tabs
                label="Type de bien"
                value={type ?? "all"}
                onChange={(v) => void navigate({ search: v === "all" ? {} : { type: v } })}
                items={[{ value: "all" as const, label: "Tout" }, ...types.map((t) => ({ value: t.type, label: TYPE_PLURAL_LABELS[t.type] }))]}
                className="pt-1"
              />
            ) : null}
            {type ? <TypeSummary type={type} items={shown} closed={data.closed.filter((c) => c.type === type)} months={data.months} /> : <Summary data={data} />}
            {shown.length === 0 ? (
              <EmptyState
                title="Aucun bien pour l'instant."
                action={
                  <Button variant="primary" onClick={() => setDialog({ item: null })}>
                    Ajouter un bien
                  </Button>
                }
              />
            ) : (
              <AssetTable items={shown} selectedId={selected?.id ?? null} onSelect={(i) => setSelectedId(i.id)} today={data.today} />
            )}
          </div>
          <aside className="bg-panel max-[1100px]:border-t max-[1100px]:border-line">
            {selected ? <Detail key={selected.id} item={selected} months={data.months} today={data.today} onEdit={() => setDialog({ item: selected })} /> : null}
          </aside>
        </div>
      )}
      {credits.length > 0 ? (
        <p className="flex flex-wrap gap-x-3 px-5 py-3 max-md:pb-6">
          {credits.map((c) => (
            <DataCredit key={c} source={c} />
          ))}
        </p>
      ) : null}
      {editing ? (
        <AssetDialog
          item={editing.item}
          onClose={() => {
            setDialog(null)
            if (search.new) void navigate({ search: { type: search.type } })
          }}
          onSaved={(id) => setSelectedId(id)}
        />
      ) : null}
    </>
  )
}

const isAutomaticSource = (item: WealthItem) =>
  item.source?.kind === "crypto" || item.source?.kind === "stock" || item.source?.kind === "real_estate"

// --- Summary ---------------------------------------------------------------------

function Change({ change, months, className }: { change: WealthChange | null; months: ReadonlyArray<Month>; className?: string }) {
  if (!change) return null
  const { amount, ratio, since } = change
  const period = since === months[0] ? "sur 12 mois" : `depuis ${formatMonthShort(since).replace(".", "")}`
  if (amount === 0) return <span className={cx("text-muted", className)}>Stable {period}</span>
  return (
    <span className={cx(amount > 0 ? "text-positive" : "text-negative", className)}>
      {formatMoney(amount, { sign: "always", decimals: 0 })}
      {/* Against a near-empty starting point the ratio (+1 500 %) says nothing. */}
      {ratio !== null && Math.abs(ratio) < 10 ? ` · ${formatPercent(ratio, { sign: true })}` : ""} {period}
    </span>
  )
}

function TypeSummary({
  type,
  items,
  closed,
  months,
}: {
  type: AssetType
  items: ReadonlyArray<WealthItem>
  closed: WealthOverview["closed"]
  months: ReadonlyArray<Month>
}) {
  const total = items.reduce((sum, i) => sum + i.value, 0)
  const history = months.map((_, m) => [...items, ...closed].reduce((sum, i) => sum + i.history[m]!, 0))
  return (
    <div className="flex items-baseline gap-3 border-b border-line px-5 pb-4 pt-5">
      <span className={heroAmountClass}>{euros(total)}</span>
      <Change change={historyChange(history, months, total)} months={months} />
      <span className="ml-auto text-faint">{TYPE_PLURAL_LABELS[type]}</span>
    </div>
  )
}

function AllocationBar({ slices, className }: { slices: AllocationSlice[]; className?: string }) {
  const visible = slices.filter((s) => s.share > 0)
  if (visible.length === 0) return null
  return (
    <div className={cx("flex h-2 gap-[2px] overflow-hidden rounded-[4px]", className)} role="img" aria-label="Répartition du patrimoine">
      {visible.map((s) => (
        <div key={s.bucket} style={{ width: `${s.share * 100}%`, background: BUCKET_COLOR[s.bucket] }} title={`${s.label} · ${euros(s.value)}`} />
      ))}
    </div>
  )
}

function Summary({ data }: { data: WealthOverview }) {
  return (
    <div className="flex flex-col gap-3 border-b border-line px-5 pb-4 pt-5">
      <div className="flex items-baseline gap-3">
        <span className={heroAmountClass} data-testid="net-worth">
          {euros(data.netWorth)}
        </span>
        <Change change={data.change} months={data.months} />
        <span className="ml-auto text-faint">Patrimoine net</span>
      </div>
      <AllocationBar slices={data.allocation} />
      <div className="flex flex-wrap gap-x-[18px] gap-y-1 text-[12px] text-fg-3">
        {data.allocation.map((s) => (
          <span key={s.bucket} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-[2px]" style={{ background: BUCKET_COLOR[s.bucket] }} />
            {s.label} <span className="num">{euros(s.value)}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

// --- Table -----------------------------------------------------------------------

const COLUMNS = "grid grid-cols-[minmax(0,1fr)_110px_110px_160px] items-center gap-3 px-5"

/** DVF publishes sales months late: the estimate says which month its data stops at. */
const dataAge = (e: { asOf: string | null }) => (e.asOf ? ` · ventes jusqu'à ${formatMonthLong(e.asOf).toLowerCase()}` : "")

function estimateCaption(item: WealthItem, today: string): { text: string; tone: "live" | "manual" | "stale" } {
  const e = item.estimate
  if (!e) return { text: isAutomaticSource(item) ? "En attente de cotation" : "Déclarative uniquement", tone: "manual" }
  if (item.stale) return { text: `À mettre à jour · ${formatDayLong(e.date)}`, tone: "stale" }
  const when = e.label === "Compte suivi" || e.label === "Tableau d'amortissement" ? "" : ` · ${e.date === today ? "aujourd'hui" : formatDayShort(e.date)}`
  return { text: `${e.label}${when}${dataAge(e)}`, tone: e.automatic ? "live" : "manual" }
}

function AssetTable({
  items,
  selectedId,
  onSelect,
  today,
}: {
  items: WealthItem[]
  selectedId: string | null
  onSelect: (item: WealthItem) => void
  today: string
}) {
  return (
    <div role="group" aria-label="Biens">
      <div aria-hidden className={cx(COLUMNS, "h-[34px] border-b border-line text-[12px] text-faint")}>
        <span>Bien</span>
        <span className="text-right">Achat</span>
        <span className="text-right">Déclarée</span>
        <span className="text-right">Estimée</span>
      </div>
      {items.map((item) => {
        const caption = estimateCaption(item, today)
        const sign = item.isLiability ? -1 : 1
        const own = (amount: number) => applyShare(amount, item.share)
        return (
          <button
            key={item.id}
            type="button"
            aria-pressed={selectedId === item.id}
            data-testid="asset-row"
            onClick={() => onSelect(item)}
            className={cx(
              COLUMNS,
              "h-[46px] w-full border-b border-line-subtle text-left hover:bg-hover",
              selectedId === item.id && "bg-hover",
            )}
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate" title={item.name}>{item.name}</span>
                {item.share === FULL_SHARE ? null : <Chip className="shrink-0">{formatShare(item.share)}</Chip>}
              </span>
              <span className="truncate text-[11px] text-faint">
                {item.isLiability ? "Passif" : TYPE_LABELS[item.type]}
                {item.subtitle ? ` · ${item.subtitle}` : ""}
              </span>
            </span>
            <span className="num text-right text-[12px] text-muted">{item.purchase ? euros(own(item.purchase.amount)) : "—"}</span>
            <span className="num text-right text-[12px] text-fg-2">{item.declared ? euros(own(item.declared.amount)) : "—"}</span>
            <span className="flex min-w-0 flex-col items-end gap-0.5">
              <span className={cx("num text-[12px]", item.retainedUsed !== "estimated" && "text-muted")}>
                {item.estimate ? euros(sign * own(item.estimate.amount)) : "—"}
              </span>
              <span
                className={cx(
                  "max-w-full truncate text-[11px]",
                  caption.tone === "live" ? "text-positive" : caption.tone === "stale" ? "text-warning" : "text-faint",
                )}
              >
                {caption.text}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

// --- Detail ----------------------------------------------------------------------

function sourceDescription(item: WealthItem): string | null {
  const s = item.source
  const unit = item.estimate?.unitPrice
  if (!s) return null
  switch (s.kind) {
    case "real_estate":
      return `${s.label ?? `Commune ${s.inseeCode}`} · ${s.surface} m² ${s.propertyType === "apartment" ? "(appartement)" : "(maison)"}${unit ? ` × ${euros(unit * 100)}/m²` : ""}`
    case "crypto":
      return `${String(s.quantity).replace(".", ",")} × ${s.label ?? s.coinId}${unit ? ` à ${formatMoney(Math.round(unit * 100))}` : ""}`
    case "stock":
      return `${String(s.quantity).replace(".", ",")} parts de ${s.label ?? s.symbol}${unit ? ` à ${formatMoney(Math.round(unit * 100))}` : ""}`
    case "loan": {
      const payment = Math.round(loanMonthlyPayment(s))
      const yours =
        item.share === FULL_SHARE
          ? `mensualité ${formatMoney(payment)}`
          : `ta part de la mensualité ${formatMoney(applyShare(payment, item.share))} sur ${formatMoney(payment)}`
      return `${euros(s.principal)} à ${String(s.annualRatePct).replace(".", ",")} % sur ${s.months / 12} ans · ${yours} · fin ${formatMonthLong(loanEndMonth(s)).toLowerCase()}`
    }
    default:
      return null
  }
}

function Detail({ item, months, today, onEdit }: { item: WealthItem; months: Month[]; today: string; onEdit: () => void }) {
  const remove = useAction(deleteAsset, { success: "Bien supprimé", invalidates: ["wealth"] })
  const { confirm, dialog: confirmDialog } = useConfirm()
  const setRetained = useAction(updateAsset, { success: "Valeur retenue modifiée", invalidates: ["wealth"] })
  const isAsset = item.kind === "asset"
  const shared = item.share !== FULL_SHARE
  const purchase = item.purchase ? applyShare(item.purchase.amount, item.share) : null
  const gain = purchase !== null && !item.isLiability && item.retainedUsed !== "purchase" ? item.value - purchase : null
  const description = sourceDescription(item)
  const credit = creditOf(item.source)

  const value = (kind: RetainedKind, label: string, whole: number | null, caption: string) => ({
    kind,
    label,
    amount: whole === null ? null : applyShare(whole, item.share),
    caption: shared && whole !== null ? [caption, `sur ${euros(whole)} au total`].filter(Boolean).join(" · ") : caption,
  })
  const values = [
    value("purchase", "Achat", item.purchase?.amount ?? null, item.purchase?.date ? formatMonthLong(item.purchase.date.slice(0, 7)).toLowerCase() : ""),
    value("declared", "Déclarée", item.declared?.amount ?? null, item.declared?.date ? `saisie le ${formatDayLong(item.declared.date)}` : ""),
    value(
      "estimated",
      "Estimée",
      item.estimate?.amount ?? null,
      item.estimate ? `${item.estimate.label} · ${formatDayShort(item.estimate.date)}${dataAge(item.estimate)}` : "aucune estimation",
    ),
  ]

  const choose = (kind: RetainedKind) => {
    if (!isAsset || kind === item.retained || !item.source) return
    setRetained.mutate({
      data: {
        id: item.id,
        input: {
          name: item.name,
          type: item.type,
          subtitle: item.subtitle,
          purchase: item.purchase,
          declared: item.declared,
          retained: kind,
          share: item.share,
          source: item.source,
          notes: item.notes,
        },
      },
    })
  }

  return (
    <div className="flex flex-col" data-testid="asset-detail">
      <div className="flex h-12 items-center gap-2 border-b border-line px-[18px]">
        <span className="min-w-0 flex-1 truncate font-medium" title={item.name}>{item.name}</span>
        {isAsset ? (
          <Menu
            trigger={
              <IconButton label="Actions du bien" size="sm">
                <MoreHorizontal size={14} />
              </IconButton>
            }
            items={[
              { label: "Modifier", icon: <Pencil size={13} />, onSelect: onEdit },
              { separator: true },
              {
                label: "Supprimer",
                danger: true,
                icon: <Trash2 size={13} />,
                onSelect: async () => (await confirm({ title: `Supprimer « ${item.name} » et son historique ?` })) && remove.mutate({ data: { id: item.id } }),
              },
            ]}
          />
        ) : null}
      </div>
      <div className="flex flex-col gap-[18px] p-[18px]">
        <div className="flex flex-col gap-1">
          <span className="text-[12px] text-faint">
            Valeur retenue{item.retainedUsed ? ` · ${RETAINED_LABEL[item.retainedUsed]}` : ""}
            {shared ? ` · ta part ${formatShare(item.share)}` : ""}
          </span>
          <span className="num text-[26px]">{euros(item.value)}</span>
          {gain !== null && purchase! > 0 ? (
            <span className={gain >= 0 ? "text-positive" : "text-negative"}>
              {formatMoney(gain, { sign: "always", decimals: 0 })} depuis l'achat ({formatPercent(gain / purchase!, { sign: true, decimals: 0 })})
            </span>
          ) : null}
        </div>

        {isAsset && !item.isLiability ? (
          <div className="flex flex-col rounded-[8px] border border-line-control">
            {values.map((v, i) => {
              const active = item.retainedUsed === v.kind
              return (
                <button
                  key={v.kind}
                  type="button"
                  disabled={v.amount === null}
                  title={v.amount === null ? undefined : "Retenir cette valeur"}
                  onClick={() => choose(v.kind)}
                  className={cx(
                    "flex items-center justify-between gap-3 px-3 py-2.5 text-left disabled:cursor-default",
                    i < values.length - 1 && "border-b border-line",
                    active ? "bg-accent-soft" : "enabled:hover:bg-hover",
                  )}
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span>
                      {v.label}
                      {active ? <span className="text-accent-fg"> · retenue</span> : null}
                    </span>
                    {v.caption ? <span className="truncate text-[11px] text-faint" title={v.caption}>{v.caption}</span> : null}
                  </span>
                  <span className="num shrink-0 text-[12px]">{v.amount === null ? "—" : euros(v.amount)}</span>
                </button>
              )
            })}
          </div>
        ) : null}

        <HistoryBars values={item.history} months={months} />

        {isAsset && item.source?.kind === "manual" ? <AddEstimate assetId={item.id} today={today} shared={shared} /> : null}

        {description || item.notes || item.kind === "account" ? (
          <div className="flex flex-col gap-1.5 text-fg-3">
            <span className="text-[12px] text-faint">Infos</span>
            {description ? <span>{description}</span> : null}
            {credit ? <DataCredit source={credit} /> : null}
            {item.notes ? <span className="whitespace-pre-line">{item.notes}</span> : null}
            {item.kind === "account" ? (
              <span>
                Repris automatiquement du budget ·{" "}
                <Link to="/accounts/$accountId" params={{ accountId: item.id }} className="text-accent-fg hover:underline">
                  voir les opérations
                </Link>
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      {confirmDialog}
    </div>
  )
}

function HistoryBars({ values, months }: { values: number[]; months: Month[] }) {
  const max = Math.max(...values.map(Math.abs))
  const min = Math.min(...values.map(Math.abs))
  if (max === 0) return null
  // Zoom on the range of values (like the design) unless it would exaggerate tiny moves.
  const floor = max - min > max * 0.02 ? Math.max(0, min - (max - min) * 0.5) : 0
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[12px] text-faint">Valeur sur 12 mois</span>
      <div className="grid h-[90px] items-end gap-[3px]" style={{ gridTemplateColumns: `repeat(${values.length}, minmax(0, 1fr))` }}>
        {values.map((v, i) => (
          <div
            key={months[i]}
            title={`${formatMonthShort(months[i]!)} ${months[i]!.slice(0, 4)} · ${euros(v)}`}
            className="rounded-[2px]"
            style={{
              height: `${Math.max(2, ((Math.abs(v) - floor) / (max - floor)) * 100)}%`,
              background: i === values.length - 1 ? "var(--accent)" : "var(--bar-inactive)",
            }}
          />
        ))}
      </div>
    </div>
  )
}

function AddEstimate({ assetId, today, shared }: { assetId: string; today: string; shared: boolean }) {
  const [amount, setAmount] = React.useState("")
  const [date, setDate] = React.useState(today)
  const add = useAction(addAssetValuation, { success: "Estimation ajoutée", onSuccess: () => setAmount(""), invalidates: ["wealth"] })
  const cents = parseAmount(amount)
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (cents !== null) add.mutate({ data: { assetId, date, amount: cents } })
      }}
    >
      <span className="text-[12px] text-faint">Nouvelle estimation{shared ? " du bien entier" : ""}</span>
      <div className="grid grid-cols-[1fr_130px_auto] gap-2">
        <Input value={amount} onChange={(e) => setAmount(e.target.value)} className="num" inputMode="decimal" placeholder="Montant" aria-label="Montant de l'estimation" />
        <DateInput value={date} max={localToday()} onChange={setDate} aria-label="Date de l'estimation" />
        <Button type="submit" size="md" disabled={cents === null} loading={add.isPending}>
          Ajouter
        </Button>
      </div>
    </form>
  )
}

// --- Mobile ----------------------------------------------------------------------

const MOBILE_FILTERS: Array<{ value: WealthBucket | "all"; label: string }> = [
  { value: "all", label: "Tout" },
  { value: "real_estate", label: "Immo" },
  { value: "investments", label: "Placements" },
  { value: "crypto", label: "Crypto" },
  { value: "objects", label: "Objets" },
  { value: "vehicles", label: "Véhicules" },
  { value: "cash", label: "Liquidités" },
]

function MobileWealth({
  data,
  items,
  openId,
  onOpen,
  onClose,
  onEdit,
}: {
  data: WealthOverview
  items: WealthItem[]
  openId: string | null
  onOpen: (item: WealthItem) => void
  onClose: () => void
  onEdit: (item: WealthItem) => void
}) {
  const [filter, setFilter] = React.useState<WealthBucket | "all">("all")
  const present = new Set(items.map((i) => i.bucket))
  const shown = items.filter((i) => filter === "all" || i.bucket === filter)
  const open = items.find((i) => i.id === openId) ?? null
  return (
    <div className="flex flex-col pb-8">
      <span className="px-5 pt-2 text-[13px] text-muted">Patrimoine net</span>
      <span className={cx(heroAmountClass, "px-5 pt-1")}>{euros(data.netWorth)}</span>
      <Change change={data.change} months={data.months} className="px-5 pt-1 text-[13px]" />
      <AllocationBar slices={data.allocation} className="mx-5 mt-4" />
      <div className="mt-4 flex gap-1.5 overflow-x-auto px-5 text-[13px]">
        {MOBILE_FILTERS.filter((f) => f.value === "all" || present.has(f.value)).map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setFilter(f.value)}
            className={cx("shrink-0 rounded-[7px] px-2.5 py-1.5", filter === f.value ? "bg-fg text-bg" : "bg-subtle")}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="mt-2.5">
        {shown.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onOpen(item)}
            className="flex w-full items-center gap-3 border-b border-line-subtle px-5 py-[11px] text-left"
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate font-medium" title={item.name}>{item.name}</span>
              <span className="truncate text-[12px] text-faint">{estimateCaption(item, data.today).text}</span>
            </span>
            <Money value={item.value} decimals={0} className="text-[14px]" />
          </button>
        ))}
      </div>
      <Sheet open={open !== null} onOpenChange={(o) => !o && onClose()} title={open?.name ?? ""}>
        <div className="flex h-12 shrink-0 items-center px-3">
          <Button variant="ghost" onClick={onClose}>
            Fermer
          </Button>
          {open?.kind === "asset" ? (
            <Button variant="ghost" className="ml-auto" onClick={() => onEdit(open)}>
              Modifier
            </Button>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {open ? <Detail key={open.id} item={open} months={data.months} today={data.today} onEdit={() => onEdit(open)} /> : null}
        </div>
      </Sheet>
    </div>
  )
}
