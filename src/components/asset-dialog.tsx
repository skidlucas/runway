import * as React from "react"
import {
  type AssetType,
  applyShare,
  FULL_SHARE,
  formatShare,
  isShare,
  loanBalance,
  loanEndMonth,
  loanMonthlyPayment,
  type RetainedKind,
  TYPE_LABELS,
} from "~/domain/wealth"
import { formatMonthLong } from "~/domain/dates"
import { formatMoney, parseAmount } from "~/domain/money"
import { localToday } from "~/lib/hooks"
import { useAction } from "~/lib/queries"
import type { ValuationSource } from "~/server/db/schema"
import { addAssetValuation, createAsset, searchCoins, searchCommunes, searchSymbols, updateAsset } from "~/server/fns/wealth"
import type { WealthItem } from "~/server/services/wealth"
import { RemotePicker } from "./pickers"
import { Button, DateInput, Dialog, Field, Input, Segmented, Select, Textarea } from "./ui"

type SourceKind = ValuationSource["kind"]

const AUTO_SOURCE: Partial<Record<AssetType, { kind: SourceKind; label: string }>> = {
  real_estate: { kind: "real_estate", label: "Prix DVF de la commune" },
  investment: { kind: "stock", label: "Cours en direct" },
  crypto: { kind: "crypto", label: "Cours en direct" },
}

const SUBTITLE_HINTS: Partial<Record<AssetType, string>> = {
  real_estate: "62 m² · Lyon 7e",
  vehicle: "48 000 km",
  watch: "Réf. 16610 · 2003",
  investment: "PEA Boursorama",
}

const centsText = (cents: number | null | undefined) => (cents == null ? "" : formatMoney(cents, { currency: false }))

type Draft = {
  name: string
  type: AssetType
  subtitle: string
  share: string
  purchase: string
  purchaseDate: string
  declared: string
  declaredDate: string
  retained: RetainedKind
  sourceKind: SourceKind
  // Automatic sources
  coin: { id: string; label: string } | null
  symbol: { id: string; label: string } | null
  commune: { id: string; label: string } | null
  quantity: string
  surface: string
  propertyType: "apartment" | "house"
  // Loan
  principal: string
  rate: string
  years: string
  startDate: string
  // Manual estimate, recorded as a valuation dated today
  estimate: string
  notes: string
}

const draftOf = (item: WealthItem | null): Draft => {
  const s = item?.source ?? { kind: "manual" as const }
  return {
    name: item?.name ?? "",
    type: item?.type ?? "real_estate",
    subtitle: item?.subtitle ?? "",
    share: String((item?.share ?? FULL_SHARE) / 100).replace(".", ","),
    purchase: centsText(item?.purchase?.amount),
    purchaseDate: item?.purchase?.date ?? "",
    declared: centsText(item?.declared?.amount),
    declaredDate: item?.declared?.date ?? "",
    retained: item?.retained ?? "estimated",
    sourceKind: item ? s.kind : "real_estate",
    coin: s.kind === "crypto" ? { id: s.coinId, label: s.label ?? s.coinId } : null,
    symbol: s.kind === "stock" ? { id: s.symbol, label: s.label ?? s.symbol } : null,
    commune: s.kind === "real_estate" ? { id: s.inseeCode, label: s.label ?? `Commune ${s.inseeCode}` } : null,
    quantity: s.kind === "crypto" || s.kind === "stock" ? String(s.quantity).replace(".", ",") : "",
    surface: s.kind === "real_estate" ? String(s.surface).replace(".", ",") : "",
    propertyType: s.kind === "real_estate" ? s.propertyType : "apartment",
    principal: s.kind === "loan" ? centsText(s.principal) : "",
    rate: s.kind === "loan" ? String(s.annualRatePct).replace(".", ",") : "",
    years: s.kind === "loan" ? String(s.months / 12).replace(".", ",") : "",
    startDate: s.kind === "loan" ? s.startDate : "",
    estimate: "",
    notes: item?.notes ?? "",
  }
}

const parseNumber = (raw: string) => {
  const n = Number(raw.replace(/\s/g, "").replace(",", "."))
  return raw.trim() === "" || !Number.isFinite(n) ? null : n
}

const optionalAmount = (raw: string) => (raw.trim() === "" ? null : parseAmount(raw))

/** Turns the form into the service input, or explains what is missing. */
const toInput = (d: Draft): { error: string } | { input: Parameters<typeof createAsset>[0]["data"]; estimate: number | null } => {
  const purchase = optionalAmount(d.purchase)
  const declared = optionalAmount(d.declared)
  const estimate = d.sourceKind === "manual" ? optionalAmount(d.estimate) : null
  const percent = parseNumber(d.share)
  const share = percent === null ? null : Math.round(percent * 100)
  if (share === null || !isShare(share)) return { error: "La part détenue doit être comprise entre 0 et 100 %." }
  let source: ValuationSource
  switch (d.type === "loan" ? "loan" : d.sourceKind) {
    case "loan": {
      const principal = parseAmount(d.principal)
      const rate = parseNumber(d.rate)
      const years = parseNumber(d.years)
      if (principal === null || rate === null || years === null || !d.startDate) {
        return { error: "Renseigne le capital, le taux, la durée et la date de début." }
      }
      source = { kind: "loan", principal, annualRatePct: rate, months: Math.round(years * 12), startDate: d.startDate }
      break
    }
    case "crypto": {
      const quantity = parseNumber(d.quantity)
      if (!d.coin || quantity === null) return { error: "Choisis la crypto et la quantité détenue." }
      source = { kind: "crypto", coinId: d.coin.id, quantity, label: d.coin.label }
      break
    }
    case "stock": {
      const quantity = parseNumber(d.quantity)
      if (!d.symbol || quantity === null) return { error: "Choisis le titre et le nombre de parts." }
      source = { kind: "stock", symbol: d.symbol.id, quantity, label: d.symbol.label }
      break
    }
    case "real_estate": {
      const surface = parseNumber(d.surface)
      if (!d.commune || surface === null) return { error: "Choisis la commune et indique la surface." }
      source = { kind: "real_estate", inseeCode: d.commune.id, surface, propertyType: d.propertyType, label: d.commune.label }
      break
    }
    default:
      source = { kind: "manual" }
  }
  if ((d.purchase.trim() && purchase === null) || (d.declared.trim() && declared === null) || (d.estimate.trim() && estimate === null)) {
    return { error: "Un des montants est invalide." }
  }
  return {
    estimate,
    input: {
      name: d.name,
      type: d.type,
      subtitle: d.subtitle || null,
      purchase: d.type === "loan" || purchase === null ? null : { amount: purchase, date: d.purchaseDate || null },
      declared: d.type === "loan" || declared === null ? null : { amount: declared, date: d.declaredDate || null },
      retained: d.type === "loan" ? "estimated" : d.retained,
      share,
      source,
      notes: d.notes || null,
    },
  }
}

export function AssetDialog({
  item,
  onClose,
  onSaved,
}: {
  item: WealthItem | null
  onClose: () => void
  onSaved?: (id: string) => void
}) {
  const [d, setD] = React.useState<Draft>(() => draftOf(item))
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setD((prev) => ({ ...prev, [key]: value }))
  const auto = AUTO_SOURCE[d.type]
  const parsed = toInput(d)

  // Set once the asset exists: if the estimate then fails, "Ajouter" again updates it instead of
  // creating a second one.
  const created = React.useRef<string | null>(null)
  const save = useAction(
    async () => {
      if ("error" in parsed) throw new Error(parsed.error)
      const existing = item?.id ?? created.current
      const id = existing
        ? await updateAsset({ data: { id: existing, input: parsed.input } }).then(() => existing)
        : await createAsset({ data: parsed.input })
      created.current = id
      if (parsed.estimate !== null) await addAssetValuation({ data: { assetId: id, date: localToday(), amount: parsed.estimate } })
      return id
    },
    {
      success: item ? "Bien mis à jour" : "Bien ajouté",
      invalidates: ["wealth"],
      onSuccess: (id) => {
        onSaved?.(id)
        onClose()
      },
    },
  )

  const changeType = (type: AssetType) =>
    setD((prev) => ({ ...prev, type, sourceKind: type === "loan" ? "loan" : (AUTO_SOURCE[type]?.kind ?? "manual") }))

  const loanPreview = (() => {
    if (d.type !== "loan" || "error" in parsed || parsed.input.source.kind !== "loan") return null
    const terms = parsed.input.source
    const share = parsed.input.share
    const owned = (amount: number) => formatMoney(applyShare(amount, share))
    const payment = share === FULL_SHARE ? "Mensualité" : `Ta part (${formatShare(share)}) : mensualité`
    return `${payment} ${owned(Math.round(loanMonthlyPayment(terms)))} · capital restant ${owned(loanBalance(terms, localToday()))} · fin ${formatMonthLong(loanEndMonth(terms)).toLowerCase()}`
  })()

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={item ? `Modifier « ${item.name} »` : "Ajouter un bien"}
      width={520}
      footer={
        <>
          <span className="text-[12px] text-negative">{"error" in parsed && d.name.trim() ? parsed.error : ""}</span>
          <div className="flex gap-2">
            <Button onClick={onClose}>Annuler</Button>
            <Button
              variant="primary"
              disabled={d.name.trim() === "" || "error" in parsed}
              loading={save.isPending}
              onClick={() => save.mutate(undefined)}
            >
              {item ? "Enregistrer" : "Ajouter"}
            </Button>
          </div>
        </>
      }
    >
      <div className="flex flex-col gap-3 px-5 py-4">
        <div className="grid grid-cols-[1fr_170px] gap-3 max-md:grid-cols-1">
          <Field label="Nom">
            <Input value={d.name} onChange={(e) => set("name", e.target.value)} autoFocus placeholder="Appartement Lyon 7e" />
          </Field>
          <Field label="Type">
            <Select
              value={d.type}
              onChange={changeType}
              options={(Object.keys(TYPE_LABELS) as AssetType[]).map((t) => ({ value: t, label: TYPE_LABELS[t] }))}
            />
          </Field>
        </div>
        <div className="grid grid-cols-[1fr_120px] gap-3">
          <Field label="Détail (facultatif)">
            <Input value={d.subtitle} onChange={(e) => set("subtitle", e.target.value)} placeholder={SUBTITLE_HINTS[d.type] ?? ""} />
          </Field>
          <Field label="Part détenue (%)">
            <Input value={d.share} onChange={(e) => set("share", e.target.value)} className="num" inputMode="decimal" placeholder="100" />
          </Field>
        </div>
        {"input" in parsed && parsed.input.share !== FULL_SHARE ? (
          <p className="-mt-1 text-[12px] text-faint">
            Saisis les montants du {d.type === "loan" ? "contrat" : "bien"} en entier : runway ne compte que ta part ({formatShare(parsed.input.share)}).
          </p>
        ) : null}

        {d.type === "loan" ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Capital emprunté">
                <Input value={d.principal} onChange={(e) => set("principal", e.target.value)} className="num" inputMode="decimal" placeholder="200 000" />
              </Field>
              <Field label="Taux annuel (%)">
                <Input value={d.rate} onChange={(e) => set("rate", e.target.value)} className="num" inputMode="decimal" placeholder="3,1" />
              </Field>
              <Field label="Durée (années)">
                <Input value={d.years} onChange={(e) => set("years", e.target.value)} className="num" inputMode="decimal" placeholder="20" />
              </Field>
              <Field label="Date de déblocage">
                <DateInput value={d.startDate} onChange={(v) => set("startDate", v)} />
              </Field>
            </div>
            {loanPreview ? <p className="text-[12px] text-muted">{loanPreview}</p> : null}
          </>
        ) : (
          <>
            <div className="grid grid-cols-[1fr_150px] gap-x-3 gap-y-3">
              <Field label="Prix d'achat">
                <Input value={d.purchase} onChange={(e) => set("purchase", e.target.value)} className="num" inputMode="decimal" placeholder="—" />
              </Field>
              <Field label="Date d'achat">
                <DateInput value={d.purchaseDate} onChange={(v) => set("purchaseDate", v)} optional />
              </Field>
              <Field label="Valeur déclarée">
                <Input value={d.declared} onChange={(e) => set("declared", e.target.value)} className="num" inputMode="decimal" placeholder="—" />
              </Field>
              <Field label="Déclarée le">
                <DateInput value={d.declaredDate} onChange={(v) => set("declaredDate", v)} optional />
              </Field>
            </div>

            <div className="flex flex-col gap-2 rounded-[10px] border border-line p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] text-muted">Estimation</span>
                {auto ? (
                  <Segmented
                    size="sm"
                    label="Estimation"
                    value={d.sourceKind === "manual" ? "manual" : "auto"}
                    onChange={(v) => set("sourceKind", v === "manual" ? "manual" : auto.kind)}
                    options={[
                      { value: "auto", label: auto.label },
                      { value: "manual", label: "À la main" },
                    ]}
                  />
                ) : null}
              </div>
              <SourceFields d={d} set={set} />
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] text-muted">Valeur retenue dans le total</span>
              <Segmented
                label="Valeur retenue dans le total"
                value={d.retained}
                onChange={(v) => set("retained", v)}
                options={[
                  { value: "purchase", label: "Achat" },
                  { value: "declared", label: "Déclarée" },
                  { value: "estimated", label: "Estimée" },
                ]}
              />
            </div>
          </>
        )}
        <Field label="Infos (facultatif)">
          <Textarea rows={2} value={d.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Boîte et papiers, assurée…" />
        </Field>
      </div>
    </Dialog>
  )
}

function SourceFields({ d, set }: { d: Draft; set: <K extends keyof Draft>(key: K, value: Draft[K]) => void }) {
  switch (d.sourceKind) {
    case "real_estate":
      return (
        <div className="grid grid-cols-[1fr_90px] gap-2">
          <RemotePicker
            value={d.commune?.label ?? null}
            placeholder="Commune"
            searchPlaceholder="Nom ou code postal"
            queryKey="commune"
            search={(query) => searchCommunes({ data: { query } })}
            describe={(c) => ({ key: c.code, title: c.name, hint: c.postcode ?? c.code })}
            onSelect={(c) => set("commune", { id: c.code, label: c.name })}
          />
          <Input value={d.surface} onChange={(e) => set("surface", e.target.value)} className="num" inputMode="decimal" placeholder="m²" aria-label="Surface en m²" />
          <Segmented
            size="sm"
            className="col-span-2 justify-self-start"
            label="Type de bien"
            value={d.propertyType}
            onChange={(v) => set("propertyType", v)}
            options={[
              { value: "apartment", label: "Appartement" },
              { value: "house", label: "Maison" },
            ]}
          />
          <p className="col-span-2 text-[12px] text-faint">
            Prix médian au m² des ventes des 12 derniers mois publiés (DVF), multiplié par la surface. Mis à jour chaque mois.
          </p>
        </div>
      )
    case "crypto":
      return (
        <div className="grid grid-cols-[1fr_120px] gap-2">
          <RemotePicker
            value={d.coin?.label ?? null}
            placeholder="Crypto-monnaie"
            searchPlaceholder="Bitcoin, ETH…"
            queryKey="coin"
            search={(query) => searchCoins({ data: { query } })}
            describe={(c) => ({ key: c.id, title: c.name, hint: c.symbol })}
            onSelect={(c) => set("coin", { id: c.id, label: `${c.name} (${c.symbol})` })}
          />
          <Input value={d.quantity} onChange={(e) => set("quantity", e.target.value)} className="num" inputMode="decimal" placeholder="Quantité" aria-label="Quantité" />
          <p className="col-span-2 text-[12px] text-faint">Cours CoinGecko en euros, mis à jour chaque jour.</p>
        </div>
      )
    case "stock":
      return (
        <div className="grid grid-cols-[1fr_120px] gap-2">
          <RemotePicker
            value={d.symbol?.label ?? null}
            placeholder="Titre, ETF ou fonds"
            searchPlaceholder="Nom, ISIN ou symbole"
            queryKey="symbol"
            search={(query) => searchSymbols({ data: { query } })}
            describe={(s) => ({ key: s.symbol, title: s.name, hint: `${s.symbol} · ${s.exchange}` })}
            onSelect={(s) => set("symbol", { id: s.symbol, label: `${s.name} (${s.symbol})` })}
          />
          <Input value={d.quantity} onChange={(e) => set("quantity", e.target.value)} className="num" inputMode="decimal" placeholder="Parts" aria-label="Nombre de parts" />
          <p className="col-span-2 text-[12px] text-faint">Dernier cours connu, converti en euros. Mis à jour chaque jour.</p>
        </div>
      )
    default:
      return (
        <div className="flex flex-col gap-2">
          <Input value={d.estimate} onChange={(e) => set("estimate", e.target.value)} className="num" inputMode="decimal" placeholder="Estimation actuelle (facultatif)" aria-label="Estimation actuelle" />
          <p className="text-[12px] text-faint">
            Pas de cote automatique fiable pour ce type de bien. Ajoute une estimation de temps en temps depuis le détail du bien : runway signale celles de plus de 6 mois.
          </p>
        </div>
      )
  }
}
