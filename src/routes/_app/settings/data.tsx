import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { AlertTriangle, Upload } from "lucide-react"
import * as React from "react"
import { AccountSelect } from "~/components/pickers"
import { PageHeader } from "~/components/shell"
import { toast, toastError } from "~/components/toast"
import { Button, Checkbox, cx, Dialog, Field, Input, Money, ProgressBar, Segmented, Select, Switch, useConfirm } from "~/components/ui"
import { compareIso, type Day, formatDayShort } from "~/domain/dates"
import { count, plural } from "~/domain/text"
import { operationsCsv } from "~/lib/csv-export"
import { downloadFile } from "~/lib/download"
import { actualExportZip, backupJson, type ExportApi, fetchExport } from "~/lib/export"
import { localToday } from "~/lib/hooks"
import type { ImportBundle } from "~/lib/import-bundle"
import { countBundleDuplicates, type ImportProgress, runBankImport, runBundleImport } from "~/lib/import-client"
import { type PendingImport, readImportFile } from "~/lib/import-file"
import { applyCsvMapping, type CsvMapping, guessCsvMapping } from "~/lib/importers/bank"
import { q, useAction } from "~/lib/queries"
import {
  countDuplicates,
  exportMeta,
  exportTransactions,
  importExtras,
  importStructure,
  importTransactions,
  seedDemo,
  wipeAllData,
} from "~/server/fns/data"

export const Route = createFileRoute("/_app/settings/data")({ component: DataSettings })

const LAST_EXPORT_KEY = "runway-last-export"
const fmt = new Intl.NumberFormat("fr-FR")

const importedMessage = (inserted: number, duplicates: number, skipped: number) =>
  `${count(inserted, "opération")} ${plural(inserted, "importée")}${duplicates ? ` · ${count(duplicates, "doublon")} ${plural(duplicates, "ignoré")}` : ""}${skipped ? ` · ${count(skipped, "opération")} sans compte ${plural(skipped, "ignorée")}` : ""}`

const importNotes = ({ skipped, approximated }: ImportBundle) =>
  [
    skipped.rules || skipped.schedules
      ? `Non repris : ${count(skipped.rules, "règle")} et ${count(skipped.schedules, "échéance")} qui utilisent des options que Runway ne gère pas.`
      : null,
    skipped.transactions ? `Non repris : ${count(skipped.transactions, "opération")} de comptes supprimés.` : null,
    skipped.budgets
      ? `Non repris : ${count(skipped.budgets, "montant")} du budget de suivi, Runway ne gère que le budget par enveloppes.`
      : null,
    approximated.schedules
      ? `${count(approximated.schedules, "échéance")} sur des jours précis ou hors week-end ${plural(approximated.schedules, "reprise")} au même jour chaque période : à vérifier après l'import.`
      : null,
  ].filter((note) => note !== null)

function DataSettings() {
  const [pending, setPending] = React.useState<PendingImport | null>(null)
  const [reading, setReading] = React.useState(false)

  const onFile = async (file: File) => {
    setReading(true)
    try {
      setPending(await readImportFile(file))
    } catch (error) {
      toastError(error)
    } finally {
      setReading(false)
    }
  }

  return (
    <>
      <PageHeader title="Réglages" crumb="Données" />
      <div className="flex max-w-[760px] flex-col gap-7 px-8 py-7 max-md:px-5">
        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-[15px] font-medium">Importer</h2>
            <p className="text-muted">Depuis Actual, une sauvegarde Runway, ou un fichier bancaire (OFX, QIF, CSV).</p>
          </div>
          <DropZone onFile={onFile} busy={reading} />
        </section>
        <ExportSection />
        <DangerZone />
      </div>
      {pending?.kind === "bundle" ? (
        <BundleImportDialog fileName={pending.fileName} bundle={pending.bundle} onClose={() => setPending(null)} />
      ) : null}
      {pending?.kind === "bank" ? <BankImportDialog pending={pending} onClose={() => setPending(null)} /> : null}
    </>
  )
}

function DropZone({ onFile, busy }: { onFile: (f: File) => void; busy: boolean }) {
  const [over, setOver] = React.useState(false)
  const input = React.useRef<HTMLInputElement>(null)
  return (
    <button
      type="button"
      onClick={() => input.current?.click()}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const file = e.dataTransfer.files[0]
        if (file) onFile(file)
      }}
      className={cx(
        "flex h-[120px] flex-col items-center justify-center gap-1.5 rounded-[10px] border border-dashed transition-colors",
        over ? "border-accent bg-accent-soft" : "border-line-strong bg-subtle hover:bg-hover",
      )}
    >
      <span className="flex items-center gap-2 font-medium">
        <Upload size={15} className="text-muted" />
        {busy ? "Lecture du fichier…" : "Déposer un fichier ici"}
      </span>
      <span className="num text-[12px] text-faint">.zip (Actual) · .json · .ofx · .qif · .csv</span>
      <input
        ref={input}
        type="file"
        data-testid="import-file"
        accept=".zip,.json,.csv,.txt,.ofx,.qfx,.qif"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onFile(file)
          e.target.value = ""
        }}
      />
    </button>
  )
}

// --- Actual / backup import ---------------------------------------------------------

type Include = {
  accounts: boolean
  categories: boolean
  transactions: boolean
  budgets: boolean
  payees: boolean
  rules: boolean
  schedules: boolean
  extras: boolean
}

function BundleImportDialog({ fileName, bundle, onClose }: { fileName: string; bundle: ImportBundle; onClose: () => void }) {
  const client = useQueryClient()
  const extrasCount = (bundle.extras?.assets.length ?? 0) + (bundle.extras?.savedViews.length ?? 0)
  const [include, setInclude] = React.useState<Include>({
    accounts: true,
    categories: true,
    transactions: true,
    budgets: true,
    payees: true,
    rules: bundle.rules.length > 0,
    schedules: bundle.schedules.length > 0,
    extras: extrasCount > 0,
  })
  const [mode, setMode] = React.useState<"merge" | "replace">("merge")
  const [duplicates, setDuplicates] = React.useState<number | null>(null)
  const [duplicatesFailed, setDuplicatesFailed] = React.useState(false)
  const [progress, setProgress] = React.useState<ImportProgress | null>(null)
  const [running, setRunning] = React.useState(false)
  const { confirm, dialog: confirmDialog } = useConfirm()
  const topLevel = bundle.transactions.filter((t) => !t.parentId).length
  const months = new Set(bundle.budgets.map((b) => b.month)).size
  const lastDate = bundle.transactions.reduce((m, t) => (compareIso(t.date, m) > 0 ? t.date : m), "")

  React.useEffect(() => {
    let cancelled = false
    countBundleDuplicates(bundle, (probes) => countDuplicates({ data: { probes } }), () => cancelled)
      .then((total) => total !== null && setDuplicates(total))
      .catch(() => !cancelled && setDuplicatesFailed(true))
    return () => {
      cancelled = true
    }
  }, [bundle])

  const toImport = include.transactions ? Math.max(0, topLevel - (mode === "merge" ? (duplicates ?? 0) : 0)) : 0

  const run = async () => {
    if (
      mode === "replace" &&
      !(await confirm({ title: "Effacer toutes les données actuelles avant l'import ?", description: "C'est irréversible.", confirmLabel: "Tout effacer et importer" }))
    )
      return
    setRunning(true)
    try {
      if (mode === "replace") await wipeAllData({ data: { confirm: "SUPPRIMER" } })
      const filtered: ImportBundle = {
        ...bundle,
        rules: include.rules ? bundle.rules : [],
        schedules: include.schedules ? bundle.schedules : [],
        budgets: include.budgets ? bundle.budgets : [],
        buffered: include.budgets ? bundle.buffered : [],
      }
      const result = await runBundleImport(
        filtered,
        { transactions: include.transactions, budgets: include.budgets, rules: include.rules, schedules: include.schedules },
        {
          importStructure: (data) => importStructure({ data }),
          importTransactions: (data) => importTransactions({ data }),
        },
        setProgress,
      )
      if (include.extras && bundle.extras) await importExtras({ data: { extras: bundle.extras, maps: result.maps } })
      await client.invalidateQueries()
      toast(importedMessage(result.inserted, result.duplicates, result.skipped))
      onClose()
    } catch (error) {
      toastError(error)
    } finally {
      setRunning(false)
    }
  }

  const items: Array<{ key: keyof Include; label: string; count: string; locked?: boolean }> = [
    { key: "accounts", label: "Comptes", count: fmt.format(bundle.accounts.length), locked: true },
    { key: "categories", label: "Catégories et groupes", count: fmt.format(bundle.categories.length), locked: true },
    { key: "transactions", label: "Opérations", count: fmt.format(topLevel) },
    { key: "budgets", label: "Historique du budget", count: `${months} mois` },
    { key: "payees", label: "Bénéficiaires", count: fmt.format(bundle.payees.filter((p) => !p.transferAccountId).length), locked: true },
    { key: "rules", label: "Règles", count: fmt.format(bundle.rules.length) },
    { key: "schedules", label: "Échéances", count: fmt.format(bundle.schedules.length) },
    ...(bundle.extras
      ? [
          {
            key: "extras" as const,
            label: "Patrimoine et vues enregistrées",
            count: `${count(bundle.extras.assets.length, "bien")} · ${count(bundle.extras.savedViews.length, "vue")}`,
          },
        ]
      : []),
  ]

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !running && onClose()}
      title={`Importer « ${fileName} »`}
      description={
        bundle.source === "actual"
          ? `Fichier Actual détecté · budget « ${bundle.name} »${lastDate ? ` · dernière opération le ${formatDayShort(lastDate)}` : ""}`
          : "Sauvegarde Runway détectée"
      }
      footer={
        <>
          <span className="text-muted">{mode === "merge" ? "Les données actuelles seront fusionnées" : "Les données actuelles seront effacées"}</span>
          <div className="flex gap-2">
            <Button onClick={onClose} disabled={running}>
              Annuler
            </Button>
            <Button variant={mode === "replace" ? "danger" : "primary"} onClick={run} loading={running} data-testid="confirm-import">
              {include.transactions ? `Importer ${count(toImport, "opération")}` : "Importer"}
            </Button>
          </div>
        </>
      }
    >
      <div className="py-2">
        {items.map((item) => (
          <label key={item.key} className="flex items-center gap-3 px-5 py-[9px]">
            <Checkbox
              checked={include[item.key]}
              label={item.label}
              disabled={item.locked}
              onCheckedChange={(c) => setInclude((s) => ({ ...s, [item.key]: c }))}
            />
            <span className={cx("flex-1", item.locked && "text-fg-2")}>{item.label}</span>
            <span className="num text-[12px] text-muted">{item.count}</span>
          </label>
        ))}
      </div>
      {mode === "merge" && duplicates ? (
        <div className="mx-5 mb-3 rounded-[8px] border border-warning-line bg-warning-soft px-3 py-2.5 text-warning">
          {fmt.format(duplicates)} opération{duplicates > 1 ? "s existent" : " existe"} déjà (même date, montant et bénéficiaire).{" "}
          {duplicates > 1 ? "Elles seront ignorées." : "Elle sera ignorée."}
        </div>
      ) : null}
      {mode === "merge" && duplicatesFailed ? (
        <div className="mx-5 mb-3 rounded-[8px] border border-warning-line bg-warning-soft px-3 py-2.5 text-warning">
          Impossible de compter à l'avance les opérations déjà présentes. Elles seront quand même ignorées à l'import.
        </div>
      ) : null}
      {importNotes(bundle).map((note) => (
        <p key={note} className="mx-5 mb-3 text-[12px] text-faint">
          {note}
        </p>
      ))}
      <div className="mx-5 mb-4 flex items-center justify-between gap-3">
        <span className="text-muted">Mode</span>
        <Segmented
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: "merge", label: "Fusionner" },
            { value: "replace", label: "Tout remplacer" },
          ]}
        />
      </div>
      {progress && progress.total > 0 ? (
        <div className="mx-5 mb-4 flex flex-col gap-1.5">
          <ProgressBar ratio={progress.done / progress.total} />
          <span className="num text-[12px] text-muted">
            {fmt.format(progress.done)} / {fmt.format(progress.total)}
          </span>
        </div>
      ) : null}
      {confirmDialog}
    </Dialog>
  )
}

// --- Bank files -----------------------------------------------------------------------

function BankImportDialog({ pending, onClose }: { pending: Extract<PendingImport, { kind: "bank" }>; onClose: () => void }) {
  const client = useQueryClient()
  const accounts = useQuery(q.accounts())
  const [chosenAccountId, setAccountId] = React.useState("")
  const accountId = chosenAccountId || (accounts.data?.find((a) => !a.closed)?.id ?? "")
  const guessed = React.useMemo(() => (pending.rows ? guessCsvMapping(pending.rows) : null), [pending.rows])
  const [mapping, setMapping] = React.useState<CsvMapping | null>(guessed?.mapping ?? null)
  const [applyRules, setApplyRules] = React.useState(true)
  const [running, setRunning] = React.useState(false)
  const [progress, setProgress] = React.useState<ImportProgress | null>(null)

  const parsed = React.useMemo(() => {
    if (pending.parsed) return pending.parsed
    if (pending.rows && mapping) return applyCsvMapping(pending.rows, mapping)
    return { transactions: [], errors: 0 }
  }, [pending, mapping])

  const run = async () => {
    if (!accountId) return
    setRunning(true)
    try {
      const result = await runBankImport(parsed, { accountId, applyRules }, (data) => importTransactions({ data }), setProgress)
      await client.invalidateQueries()
      toast(importedMessage(result.inserted, result.duplicates, result.skipped))
      onClose()
    } catch (error) {
      toastError(error)
    } finally {
      setRunning(false)
    }
  }

  const columnOptions = (guessed?.headers ?? []).map((h, i) => ({ value: String(i), label: h || `Colonne ${i + 1}` }))
  const setCol = (key: keyof CsvMapping, value: string) =>
    setMapping((m) => (m ? { ...m, [key]: value === "" ? null : Number(value) } : m))

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !running && onClose()}
      title={`Importer « ${pending.fileName} »`}
      description={`Fichier ${pending.format.toUpperCase()} · ${count(parsed.transactions.length, "opération")} ${plural(parsed.transactions.length, "lue")}${parsed.errors ? ` · ${count(parsed.errors, "ligne")} ${plural(parsed.errors, "illisible")}` : ""}`}
      width={640}
      footer={
        <>
          <label className="flex items-center gap-2 text-muted">
            <Switch checked={applyRules} onCheckedChange={setApplyRules} label="Appliquer les règles" />
            Catégoriser avec les règles
          </label>
          <div className="flex gap-2">
            <Button onClick={onClose} disabled={running}>
              Annuler
            </Button>
            <Button variant="primary" onClick={run} loading={running} disabled={!accountId || parsed.transactions.length === 0} data-testid="confirm-import">
              Importer {count(parsed.transactions.length, "opération")}
            </Button>
          </div>
        </>
      }
    >
      <div className="flex flex-col gap-4 px-5 py-4">
        <Field label="Dans le compte">
          {accounts.data?.length ? <AccountSelect value={accountId} onChange={setAccountId} /> : <span className="text-warning">Crée d'abord un compte.</span>}
        </Field>
        {mapping && guessed ? (
          <div className="grid grid-cols-3 gap-2 max-md:grid-cols-2">
            <Field label="Date">
              <Select value={String(mapping.date)} onChange={(v) => setCol("date", v)} options={columnOptions} />
            </Field>
            <Field label="Format de date">
              <Select
                value={mapping.dateFormat}
                onChange={(v) => setMapping((m) => (m ? { ...m, dateFormat: v } : m))}
                options={[
                  { value: "dmy", label: "jj/mm/aaaa" },
                  { value: "mdy", label: "mm/jj/aaaa" },
                  { value: "ymd", label: "aaaa-mm-jj" },
                ]}
              />
            </Field>
            <Field label="Bénéficiaire / libellé">
              <Select value={String(mapping.payee)} onChange={(v) => setCol("payee", v)} options={columnOptions} />
            </Field>
            <Field label="Montant">
              <Select value={mapping.amount === null ? "" : String(mapping.amount)} onChange={(v) => setCol("amount", v)} options={columnOptions} placeholder="(débit / crédit)" />
            </Field>
            <Field label="Débit">
              <Select value={mapping.debit === null ? "" : String(mapping.debit)} onChange={(v) => setCol("debit", v)} options={columnOptions} placeholder="—" />
            </Field>
            <Field label="Crédit">
              <Select value={mapping.credit === null ? "" : String(mapping.credit)} onChange={(v) => setCol("credit", v)} options={columnOptions} placeholder="—" />
            </Field>
            <label className="col-span-3 flex items-center gap-2 text-muted max-md:col-span-2">
              <Checkbox checked={mapping.hasHeader} onCheckedChange={(c) => setMapping((m) => (m ? { ...m, hasHeader: c } : m))} label="Ligne d'en-tête" />
              La première ligne contient les noms des colonnes
            </label>
          </div>
        ) : null}
        <div className="overflow-hidden rounded-[8px] border border-line">
          {parsed.transactions.slice(0, 6).map((t, i) => (
            <div key={i} className={cx("grid grid-cols-[80px_minmax(0,1fr)_110px] gap-3 px-3 py-2", i > 0 && "border-t border-line-subtle")}>
              <span className="num text-[12px] text-muted">{formatDayShort(t.date)}</span>
              <span className="truncate">{t.payee}</span>
              <Money value={t.amount} className="text-right text-[12px]" colored />
            </div>
          ))}
          {parsed.transactions.length === 0 ? <p className="px-3 py-3 text-muted">Aucune opération lisible avec ces colonnes.</p> : null}
        </div>
        {progress ? <ProgressBar ratio={progress.done / Math.max(1, progress.total)} /> : null}
      </div>
    </Dialog>
  )
}

// --- Export -------------------------------------------------------------------------

const exportApi: ExportApi = { exportMeta: () => exportMeta(), exportTransactions: (data) => exportTransactions({ data }) }

function ExportSection() {
  const [busy, setBusy] = React.useState<string | null>(null)
  const [last, setLast] = React.useState<Day | null>(null)
  React.useEffect(() => {
    try {
      setLast(localStorage.getItem(LAST_EXPORT_KEY))
    } catch {}
  }, [])

  const run = async (key: string, write: (today: Day) => Promise<void>) => {
    setBusy(key)
    try {
      const today = localToday()
      await write(today)
      setLast(today)
      try {
        localStorage.setItem(LAST_EXPORT_KEY, today)
      } catch {}
    } catch (error) {
      toastError(error)
    } finally {
      setBusy(null)
    }
  }

  const exportActual = () =>
    run("actual", async (today) => {
      const { zip, skippedRules } = await actualExportZip(exportApi)
      downloadFile(zip, `runway-actual-${today}.zip`, "application/zip")
      toast(skippedRules ? `Export prêt · ${count(skippedRules, "règle")} sur montant non ${plural(skippedRules, "exportée")}` : "Export Actual prêt")
    })

  const exportCsv = () =>
    run("csv", async (today) => {
      downloadFile(operationsCsv(await fetchExport(exportApi)), `runway-operations-${today}.csv`, "text/csv;charset=utf-8")
    })

  const exportJson = () =>
    run("json", async (today) => {
      downloadFile(backupJson(await fetchExport(exportApi)), `runway-sauvegarde-${today}.json`, "application/json")
    })

  const rows = [
    { key: "actual", title: "Format Actual", hint: "Réimportable dans Actual Budget", action: exportActual, primary: true },
    { key: "csv", title: "CSV", hint: "Opérations uniquement, une ligne par opération", action: exportCsv },
    { key: "json", title: "JSON complet", hint: "Comptes, budget, patrimoine, règles : sauvegarde restaurable", action: exportJson },
  ]
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-[15px] font-medium">Exporter</h2>
        <p className="text-muted">{last ? `Dernier export : ${formatDayShort(last)} ${last.slice(0, 4)}` : "Aucun export depuis cet appareil"}</p>
      </div>
      <div className="rounded-[10px] border border-line">
        {rows.map((r, i) => (
          <div key={r.key} role="group" aria-label={r.title} className={cx("flex items-center gap-3 px-4 py-3.5", i > 0 && "border-t border-line")}>
            <span className="flex flex-1 flex-col gap-0.5">
              <span className="font-medium">{r.title}</span>
              <span className="text-muted">{r.hint}</span>
            </span>
            <Button variant={r.primary ? "inverse" : "secondary"} onClick={r.action} loading={busy === r.key} disabled={busy !== null}>
              {r.key === "actual" ? "Exporter .zip" : "Exporter"}
            </Button>
          </div>
        ))}
      </div>
    </section>
  )
}

function DangerZone() {
  const client = useQueryClient()
  const [confirm, setConfirm] = React.useState("")
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const demo = useAction(seedDemo, { success: (r) => `Démo chargée : ${count(r.transactions, "opération")}`, writes: ["everything"] })
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-[15px] font-medium">Zone sensible</h2>
        <p className="text-muted">Pour repartir de zéro, ou tester avec des données de démonstration.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => demo.mutate(undefined)} loading={demo.isPending}>
          Charger des données de démonstration
        </Button>
        <Button
          variant="danger"
          icon={<AlertTriangle size={13} />}
          onClick={() => {
            setConfirm("")
            setOpen(true)
          }}
        >
          Effacer toutes les données
        </Button>
      </div>
      {open ? (
        <Dialog
          open
          onOpenChange={setOpen}
          title="Effacer toutes les données"
          description="Comptes, opérations, budget, règles, échéances et patrimoine seront supprimés. Pense à exporter avant."
          width={420}
          footer={
            <>
              <span />
              <Button
                variant="danger"
                disabled={confirm !== "SUPPRIMER"}
                loading={busy}
                onClick={async () => {
                  setBusy(true)
                  try {
                    await wipeAllData({ data: { confirm: "SUPPRIMER" } })
                    await client.invalidateQueries()
                    toast("Toutes les données ont été effacées")
                    setOpen(false)
                  } catch (error) {
                    toastError(error)
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                Effacer
              </Button>
            </>
          }
        >
          <div className="px-5 py-4">
            <Field label="Tape SUPPRIMER pour confirmer">
              <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoFocus />
            </Field>
          </div>
        </Dialog>
      ) : null}
    </section>
  )
}
