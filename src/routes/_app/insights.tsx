import { useQuery } from "@tanstack/react-query"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Command } from "cmdk"
import { Bookmark, Check, ChevronDown, Sparkles, X } from "lucide-react"
import * as React from "react"
import { MonthlyChart } from "~/components/monthly-chart"
import { PageHeader } from "~/components/shell"
import { Button, ChipButton, cx, Dialog, Dot, EmptyState, Field, Input, Kpi, Menu, Money, Popover, SkeletonRows, Spinner, Tabs, useConfirm } from "~/components/ui"
import { toastError } from "~/components/toast"
import { formatMonthName } from "~/domain/dates"
import type { Finding, FindingTone } from "~/domain/insights"
import { formatCompact, formatMoney } from "~/domain/money"
import { commandFilter, commandGroupClass, commandInputClass, commandItemClass, commandListClass, MAX_PAYEE_OPTIONS } from "~/components/pickers"
import { normalizeText } from "~/domain/rules"
import { parseInsightSearch, queryToSearch, searchToQuery } from "~/lib/insight-search"
import { q, useAction } from "~/lib/queries"
import type { InsightViewConfig } from "~/server/db/schema"
import { deleteView, getAiAnalysis, interpretQuestion, saveView } from "~/server/fns/insights"
import type { AiAnalysis, InsightViewDto } from "~/server/services/insights"
import { capitalize, count } from "~/domain/text"

export const Route = createFileRoute("/_app/insights")({
  validateSearch: parseInsightSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    Promise.all([
      context.queryClient.ensureQueryData(q.insightView(searchToQuery(deps))),
      context.queryClient.ensureQueryData(q.findings()),
      context.queryClient.ensureQueryData(q.savedViews()),
    ]),
  component: InsightsPage,
})

const TONE_COLOR: Record<FindingTone, string> = {
  negative: "var(--negative)",
  positive: "var(--positive)",
  warning: "var(--warning)",
  accent: "var(--accent)",
}

const MONTH_OPTIONS = [3, 6, 12, 24] as const
const ROLLING_OPTIONS = [0, 3, 6, 12] as const

function useQueryNavigation() {
  const navigate = useNavigate()
  const search = Route.useSearch()
  const query = searchToQuery(search)
  const setQuery = (patch: Partial<InsightViewConfig>) =>
    navigate({ to: "/insights", search: queryToSearch({ ...query, ...patch }), replace: false })
  return { query, setQuery }
}

function InsightsPage() {
  const { query } = useQueryNavigation()
  const view = useQuery(q.insightView(query))
  const findings = useQuery(q.findings())
  const v = view.data

  return (
    <>
      <PageHeader title="Insights" crumb={v?.label ?? "…"} right={<AskBox />} />
      <ViewTabs />
      <QueryBar />
      {!v ? (
        <SkeletonRows rows={10} />
      ) : (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)_360px] max-[1100px]:grid-cols-1 max-md:hidden">
            <div className="flex min-w-0 flex-col border-r border-line pb-6 max-[1100px]:border-r-0">
              <ViewKpis v={v} />
              <MonthlyChart v={v} />
              <Breakdown v={v} />
            </div>
            <aside className="flex flex-col bg-panel max-[1100px]:border-t max-[1100px]:border-line">
              <FindingsPanel findings={findings.data?.findings} />
              <AiPanel />
            </aside>
          </div>
          <div className="md:hidden">
            <MobileInsights v={v} findings={findings.data?.findings} />
          </div>
        </>
      )}
    </>
  )
}

// --- Saved views ---------------------------------------------------------------

const EXPLORE = "explore"

function ViewTabs() {
  const navigate = useNavigate()
  const { query } = useQueryNavigation()
  const views = useQuery(q.savedViews())
  const remove = useAction((id: string) => deleteView({ data: { id } }), { success: "Vue supprimée", invalidates: ["savedViews", "dashboards"] })
  const { confirm, dialog: confirmDialog } = useConfirm()
  if (!views.data?.length) return null
  const current = JSON.stringify(queryToSearch(query))
  const active = views.data.find((view) => JSON.stringify(queryToSearch(view.config)) === current)
  return (
    <>
    <Tabs
      label="Vues enregistrées"
      value={active?.id ?? EXPLORE}
      onChange={(id) => {
        const view = views.data.find((v) => v.id === id)
        void navigate({ to: "/insights", search: view ? queryToSearch(view.config) : {} })
      }}
      items={[
        { value: EXPLORE, label: "Exploration" },
        ...views.data.map((view) => ({
          value: view.id,
          label: view.name,
          action: {
            label: `Supprimer la vue ${view.name}`,
            icon: <X size={12} />,
            run: async () => {
              if (await confirm({ title: `Supprimer la vue « ${view.name} » ?` }))
                remove.mutate(view.id)
            },
          },
        })),
      ]}
    />
    {confirmDialog}
    </>
  )
}

// --- Query bar -----------------------------------------------------------------

const QueryChip = ({ label, value, ...props }: { label: string; value: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
  <ChipButton label={label} {...props}>
    <span className="max-w-[220px] truncate" title={typeof value === "string" ? value : undefined}>{value}</span>
  </ChipButton>
)

function QueryBar() {
  const { query, setQuery } = useQueryNavigation()
  const view = useQuery(q.insightView(query))
  const [saving, setSaving] = React.useState(false)
  return (
    <div className="flex h-12 items-center gap-1.5 overflow-x-auto border-b border-line px-5 max-md:h-11 max-md:border-none">
      <Menu
        align="start"
        trigger={<QueryChip label="Mesure" value={query.measure === "income" ? "Revenus" : "Dépenses"} />}
        items={[
          { label: "Dépenses", onSelect: () => setQuery({ measure: "expenses", target: { kind: "all" } }) },
          { label: "Revenus", onSelect: () => setQuery({ measure: "income", target: { kind: "all" } }) },
        ]}
      />
      <TargetPicker />
      <Menu
        align="start"
        trigger={<QueryChip label="Période" value={`${query.months} mois`} />}
        items={MONTH_OPTIONS.map((m) => ({ label: `${m} mois`, onSelect: () => setQuery({ months: m }) }))}
      />
      <Menu
        align="start"
        trigger={<QueryChip label="Moyenne" value={query.rolling ? `${query.rolling} mois glissants` : "aucune"} />}
        items={ROLLING_OPTIONS.map((r) => ({
          label: r ? `${r} mois glissants` : "Aucune",
          onSelect: () => setQuery({ rolling: r }),
        }))}
      />
      <Button variant="ghost" size="sm" icon={<Bookmark size={13} />} onClick={() => setSaving(true)} className="ml-1 shrink-0">
        Enregistrer la vue
      </Button>
      <SaveViewDialog
        open={saving}
        onOpenChange={setSaving}
        query={query}
        defaultName={view.data ? `${view.data.label} · ${query.months} mois` : ""}
      />
    </div>
  )
}

function TargetPicker() {
  const { query, setQuery } = useQueryNavigation()
  const view = useQuery(q.insightView(query))
  const categories = useQuery(q.categories())
  const payees = useQuery(q.payees())
  const [open, setOpen] = React.useState(false)
  const [search, setSearch] = React.useState("")
  const income = query.measure === "income"
  const groups = (categories.data ?? []).filter((g) => g.isIncome === income && !g.hidden)
  // Payees are narrowed by hand before cmdk sees them: it scores every item on each keystroke,
  // which lags with thousands of imported payees.
  const indexed = React.useMemo(
    () => (payees.data ?? []).filter((p) => !p.transferAccountId && p.transactionCount > 0).map((p) => ({ payee: p, key: normalizeText(p.name) })),
    [payees.data],
  )
  const parts = normalizeText(search).split(" ").filter(Boolean)
  const payeeOptions = indexed
    .filter((p) => parts.every((part) => p.key.includes(part)))
    .slice(0, MAX_PAYEE_OPTIONS)
    .map((p) => p.payee)
  const select = (target: InsightViewConfig["target"]) => {
    setQuery({ target })
    setOpen(false)
  }
  const kindLabel = { all: "Catégorie", category: "Catégorie", group: "Groupe", payee: "Bénéficiaire" }[query.target.kind]
  const current = query.target.kind === "all" ? "" : query.target.id
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setSearch("")
        setOpen(next)
      }}
      className="w-[320px]"
      trigger={
        <QueryChip label={kindLabel} value={query.target.kind === "all" ? "Toutes" : (view.data?.label ?? "…")}>
          <ChevronDown size={12} className="text-faint" />
        </QueryChip>
      }
    >
      <Command loop filter={commandFilter}>
        <Command.Input
          autoFocus
          value={search}
          onValueChange={setSearch}
          placeholder="Catégorie, groupe ou bénéficiaire"
          className={commandInputClass}
        />
        <Command.List className={commandListClass}>
          <Command.Empty className="px-2 py-3 text-muted">Aucun résultat</Command.Empty>
          <Command.Item value="__all" keywords={["toutes", "tout"]} onSelect={() => select({ kind: "all" })} className={commandItemClass}>
            <span className="flex-1">{income ? "Tous les revenus" : "Toutes les dépenses"}</span>
            {query.target.kind === "all" ? <Check size={13} className="text-accent-fg" /> : null}
          </Command.Item>
          <Command.Group heading="Groupes" className={commandGroupClass}>
            {groups.map((g) => (
              <Command.Item key={g.id} value={`group-${g.id}`} keywords={[g.name]} onSelect={() => select({ kind: "group", id: g.id })} className={commandItemClass}>
                <span className="flex-1 truncate" title={g.name}>{g.name}</span>
                {current === g.id ? <Check size={13} className="text-accent-fg" /> : null}
              </Command.Item>
            ))}
          </Command.Group>
          <Command.Group heading="Catégories" className={commandGroupClass}>
            {groups.flatMap((g) =>
              g.categories
                .filter((c) => !c.hidden)
                .map((c) => (
                  <Command.Item
                    key={c.id}
                    value={`category-${c.id}`}
                    keywords={[c.name, g.name]}
                    onSelect={() => select({ kind: "category", id: c.id })}
                    className={commandItemClass}
                  >
                    <span className="flex-1 truncate" title={c.name}>{c.name}</span>
                    <span className="text-[12px] text-faint">{g.name}</span>
                    {current === c.id ? <Check size={13} className="text-accent-fg" /> : null}
                  </Command.Item>
                )),
            )}
          </Command.Group>
          <Command.Group heading="Bénéficiaires" className={commandGroupClass}>
            {payeeOptions.map((p) => (
              <Command.Item
                key={p.id}
                value={`payee-${p.id}`}
                keywords={[p.name]}
                onSelect={() => select({ kind: "payee", id: p.id })}
                className={commandItemClass}
              >
                <span className="flex-1 truncate" title={p.name}>{p.name}</span>
                {current === p.id ? <Check size={13} className="text-accent-fg" /> : null}
              </Command.Item>
            ))}
          </Command.Group>
        </Command.List>
      </Command>
    </Popover>
  )
}

function SaveViewDialog({
  open,
  onOpenChange,
  query,
  defaultName,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  query: InsightViewConfig
  defaultName: string
}) {
  const [name, setName] = React.useState(defaultName)
  // The name is suggested on each opening only: a refetch while typing must not overwrite it.
  const [wasOpen, setWasOpen] = React.useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setName(defaultName)
  }
  const save = useAction((input: { name: string; config: InsightViewConfig }) => saveView({ data: input }), {
    success: "Vue enregistrée",
    onSuccess: () => onOpenChange(false),
    invalidates: ["savedViews"],
  })
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Enregistrer la vue"
      description="Elle apparaîtra dans la barre latérale, sous Insights."
      width={420}
      footer={
        <>
          <span />
          <Button variant="primary" disabled={!name.trim() || save.isPending} onClick={() => save.mutate({ name, config: query })}>
            Enregistrer
          </Button>
        </>
      }
    >
      <form
        className="p-5"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim() && !save.isPending) save.mutate({ name, config: query })
        }}
      >
        <Field label="Nom">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </form>
    </Dialog>
  )
}

function AskBox() {
  const navigate = useNavigate()
  const ai = useQuery(q.aiStatus())
  const [question, setQuestion] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)
  if (!ai.data?.analysis) return null
  return (
    <form
      className="relative flex items-center max-md:w-full"
      onSubmit={async (e) => {
        e.preventDefault()
        if (!question.trim() || pending) return
        setPending(true)
        setMessage(null)
        try {
          const result = await interpretQuestion({ data: { question } })
          if (result.query) {
            await navigate({ to: "/insights", search: queryToSearch(result.query) })
            setQuestion("")
          } else setMessage(result.message)
        } catch (error) {
          toastError(error)
        } finally {
          setPending(false)
        }
      }}
    >
      <span className="pointer-events-none absolute left-2.5 text-faint">
        {pending ? <Spinner className="h-3.5 w-3.5" /> : <Sparkles size={14} />}
      </span>
      <Input
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="Pose une question…"
        aria-label="Poser une question sur tes dépenses"
        className="h-8 w-[260px] pl-8 max-md:w-full"
        title="Ex. : « restos sur 6 mois », « Monoprix cette année »"
      />
      {message ? (
        <span className="absolute right-0 top-[calc(100%+6px)] z-20 w-[300px] rounded-[8px] border border-line-control bg-elevated px-3 py-2 text-[12px] text-muted">
          {message}
        </span>
      ) : null}
    </form>
  )
}

// --- View ----------------------------------------------------------------------

function ViewKpis({ v }: { v: InsightViewDto }) {
  const monthLabel = capitalize(formatMonthName(v.month))
  return (
    <div className="grid grid-cols-3 gap-5 px-5 pt-5">
      <Kpi size="lg" label={`${monthLabel} (en cours)`} value={formatMoney(v.current)} />
      {v.average !== null ? (
        <Kpi size="lg" label={`Moyenne ${v.query.rolling} mois`} value={formatMoney(v.average)} />
      ) : (
        <Kpi size="lg" label={`Moyenne sur ${v.query.months} mois`} value={formatMoney(v.periodAverage)} />
      )}
      <Kpi
        label="Projection fin de mois"
        value={formatMoney(v.projection)}
        size="lg"
        valueClassName={v.projectionAlert ? "text-negative" : undefined}
        hint={v.budget ? `Budget ${formatMoney(v.budget)}` : undefined}
      />
    </div>
  )
}

function Breakdown({ v }: { v: InsightViewDto }) {
  const { setQuery } = useQueryNavigation()
  const rows = v.breakdown.rows
  const top = rows[0]?.amount ?? 1
  const title = v.breakdown.by === "payee" ? "Par bénéficiaire" : "Par catégorie"
  return (
    <>
      <div className="mt-6 px-5 pb-2 font-medium">
        {title} · {v.query.months} mois
      </div>
      {rows.length === 0 ? (
        <p className="px-5 text-muted">Aucune opération sur la période.</p>
      ) : (
        rows.map((r) => (
          <button
            type="button"
            key={r.id ?? r.name}
            disabled={!r.id}
            onClick={() => r.id && setQuery({ target: { kind: v.breakdown.by === "payee" ? "payee" : "category", id: r.id } })}
            className="grid h-[34px] w-full grid-cols-[180px_minmax(0,1fr)_100px_80px] items-center gap-3.5 border-t border-line-subtle px-5 text-left hover:bg-hover disabled:hover:bg-transparent"
          >
            <span className="truncate" title={r.name}>{r.name}</span>
            <span className="h-1 rounded-[2px] bg-pill">
              <span className="block h-1 rounded-[2px] bg-accent" style={{ width: `${(r.amount / top) * 100}%` }} />
            </span>
            <span className="num text-right text-[12px]">{formatMoney(r.amount)}</span>
            <span className="num text-right text-[12px] text-muted">{r.count} opé.</span>
          </button>
        ))
      )}
    </>
  )
}

// --- Findings & AI -------------------------------------------------------------

function FindingRow({ f, mobile }: { f: Finding; mobile?: boolean }) {
  return (
    <div className={cx("flex gap-2.5 border-t border-line-subtle", mobile ? "px-5 py-3.5" : "px-[18px] py-3")}>
      <Dot color={TONE_COLOR[f.tone]} className="mt-[7px]" />
      <span className="flex min-w-0 flex-col gap-[3px]">
        <span className="leading-[1.45] [text-wrap:pretty]">{f.text}</span>
        <span className="text-[12px] text-faint">{f.context}</span>
      </span>
    </div>
  )
}

function FindingsPanel({ findings }: { findings: Finding[] | undefined }) {
  return (
    <section aria-label="Constats du mois">
      <div className="px-[18px] pb-2.5 pt-4 font-medium">Constats du mois</div>
      {!findings ? (
        <SkeletonRows rows={4} height={56} />
      ) : findings.length === 0 ? (
        <p className="border-t border-line-subtle px-[18px] py-3 text-muted">Rien de notable pour l'instant ce mois-ci.</p>
      ) : (
        findings.map((f, i) => <FindingRow key={`${f.kind}-${i}`} f={f} />)
      )}
    </section>
  )
}

const AI_TONE: Record<AiAnalysis["points"][number]["tone"], string> = {
  positive: "var(--positive)",
  negative: "var(--negative)",
  neutral: "var(--text-muted)",
}

function AiPanel({ mobile }: { mobile?: boolean }) {
  const ai = useQuery(q.aiStatus())
  const [analysis, setAnalysis] = React.useState<AiAnalysis | null>(null)
  const [pending, setPending] = React.useState(false)
  if (ai.data && !ai.data.analysis) {
    return (
      <p className={cx("border-t border-line-subtle py-3 text-[12px] text-faint", mobile ? "px-5" : "px-[18px]")}>
        Ajoute une clé OPENAI_API_KEY ou ANTHROPIC_API_KEY pour obtenir une analyse rédigée par l'IA.
      </p>
    )
  }
  return (
    <section aria-label="Analyse IA" className="border-t border-line">
      <div className={cx("flex items-center justify-between pb-2.5 pt-4", mobile ? "px-5" : "px-[18px]")}>
        <span className="flex items-center gap-1.5 font-medium">
          <Sparkles size={14} className="text-accent-fg" /> Analyse IA
        </span>
        <Button
          size="sm"
          loading={pending}
          onClick={async () => {
            setPending(true)
            try {
              setAnalysis(await getAiAnalysis())
            } catch (error) {
              toastError(error)
            } finally {
              setPending(false)
            }
          }}
        >
          {analysis ? "Relancer" : "Analyser le mois"}
        </Button>
      </div>
      {analysis ? (
        <div className="flex flex-col">
          <p className={cx("pb-3 leading-[1.45] text-fg-2", mobile ? "px-5" : "px-[18px]")}>{analysis.headline}</p>
          {analysis.points.map((p, i) => (
            <div key={i} className={cx("flex gap-2.5 border-t border-line-subtle py-3", mobile ? "px-5" : "px-[18px]")}>
              <Dot color={AI_TONE[p.tone]} className="mt-[7px]" />
              <span className="flex min-w-0 flex-col gap-[3px]">
                <span className="leading-[1.45]">{p.title}</span>
                <span className="text-[12px] text-faint">{p.detail}</span>
              </span>
            </div>
          ))}
          <p className={cx("pb-4 pt-2 text-[11px] text-faint", mobile ? "px-5" : "px-[18px]")}>
            Rédigé par {ai.data?.model ?? "l'IA"} à partir de tes chiffres ; peut se tromper.
          </p>
        </div>
      ) : (
        <p className={cx("pb-4 text-[12px] text-faint", mobile ? "px-5" : "px-[18px]")}>
          Une lecture rédigée de ton mois : tendances, dérives et pistes d'ajustement.
        </p>
      )}
    </section>
  )
}

// --- Mobile --------------------------------------------------------------------

function MobileInsights({ v, findings }: { v: InsightViewDto; findings: Finding[] | undefined }) {
  const vsAverage = v.average && v.query.rolling > 0 ? v.projection / v.average - 1 : null
  return (
    <div className="flex flex-col pb-8">
      <div className="px-5 pb-3.5 text-[13px] text-muted">{capitalize(formatMonthName(v.month))}</div>
      <div className="mx-5 flex flex-col gap-1.5 rounded-[12px] bg-highlight p-4 text-highlight-fg">
        <span className="text-[12px] text-highlight-muted">{v.label} · ce mois</span>
        <Money value={v.current} className="text-[28px]" />
        <span className="text-[13px] text-highlight-fg-2">
          Projection {formatMoney(v.projection)}
          {vsAverage !== null && Math.abs(vsAverage) >= 0.01
            ? `, soit ${Math.round(Math.abs(vsAverage) * 100)} % ${vsAverage > 0 ? "au-dessus" : "en dessous"} de ta moyenne sur ${v.query.rolling} mois.`
            : "."}
        </span>
      </div>
      <MonthlyChart v={v} compact />
      <div className="mt-2">
        {!findings ? (
          <SkeletonRows rows={3} height={56} />
        ) : findings.length === 0 ? (
          <EmptyState title="Rien de notable pour l'instant ce mois-ci." className="py-8" />
        ) : (
          findings.map((f, i) => <FindingRow key={`${f.kind}-${i}`} f={f} mobile />)
        )}
      </div>
      <AiPanel mobile />
      <div className="px-5 pb-1 pt-5 text-[13px] text-muted">
        {v.breakdown.by === "payee" ? "Par bénéficiaire" : "Par catégorie"} · {v.query.months} mois
      </div>
      {v.breakdown.rows.map((r) => (
        <div key={r.id ?? r.name} className="flex items-center justify-between border-b border-line-subtle px-5 py-3">
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium" title={r.name}>{r.name}</span>
            <span className="text-[12px] text-faint">
              {count(r.count, "opération")}
            </span>
          </span>
          <span className="num">{formatCompact(r.amount)}</span>
        </div>
      ))}
    </div>
  )
}

