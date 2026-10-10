import { Context, Effect, Layer, Schema } from "effect"
import { isDay } from "~/domain/dates"
import { type ExternalError, Invalid } from "../errors"
import { Ai, type AiFile } from "./ai"
import { MarketData } from "./market-data"

// What the model reads. Loose types on purpose: a date or currency it gets wrong is dropped
// below rather than failing the whole reading.
const Reading = Schema.Struct({
  readable: Schema.Boolean,
  kind: Schema.Literals(["expense", "income"]),
  amount: Schema.NullOr(Schema.Number),
  currency: Schema.String,
  payee: Schema.NullOr(Schema.String),
  date: Schema.NullOr(Schema.String),
  notes: Schema.NullOr(Schema.String),
})

export type ReceiptDraft = {
  kind: "expense" | "income"
  /** Positive cents in euros, already converted; null when unreadable or the rate is missing. */
  amount: number | null
  payee: string | null
  date: string | null
  notes: string | null
  /** Set when the document is in another currency; `rate` is null when no rate could be found. */
  foreign: { amount: number; currency: string; rate: number | null } | null
}

const SYSTEM = [
  "Tu lis une capture d'écran ou un PDF (facture, ticket, panier, confirmation de commande ou de paiement) pour pré-remplir UNE opération d'un budget personnel.",
  "readable = false si le document ne montre aucun paiement ni encaissement.",
  "kind : expense pour un achat ou une facture à payer, income pour un remboursement, un virement reçu ou un paiement encaissé.",
  "amount : le total réellement payé ou reçu, TTC, frais de port inclus, en nombre positif dans la devise du document (pas en centimes). null si illisible.",
  "currency : code ISO 4217 de ce montant (EUR, USD, GBP…), EUR si rien ne l'indique.",
  "payee : le commerçant ou l'émetteur, nom court et usuel (« Amazon », pas « Amazon EU S.à r.l. »). null si inconnu.",
  "date : date de la facture, de la commande ou du paiement, au format AAAA-MM-JJ. Une date sans année est dans l'année de `today`, ou la précédente si elle tomberait après `today`. null si absente.",
  "notes : en français, moins de 80 caractères, les articles achetés ou un résumé (« 2 livres, câble USB-C »). Jamais de numéro de facture, de commande ou de client. null si rien d'utile.",
].join("\n")

const MAX_TEXT = 200

const cleanText = (value: string | null) => {
  const trimmed = value?.trim() ?? ""
  return trimmed === "" ? null : trimmed.slice(0, MAX_TEXT)
}

const formatForeign = (cents: number, currency: string) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency }).format(cents / 100)

export class Receipts extends Context.Service<
  Receipts,
  {
    /** Reads one operation from an image or a PDF. Nothing is written: the form shows the draft. */
    read(args: { file: AiFile; today: string }): Effect.Effect<ReceiptDraft, ExternalError | Invalid>
  }
>()("runway/server/services/Receipts") {
  static readonly layer = Layer.effect(
    Receipts,
    Effect.gen(function* () {
      const ai = yield* Ai
      const market = yield* MarketData

      const read = Effect.fn("Receipts.read")(function* (args: { file: AiFile; today: string }) {
        const reading = yield* ai.generate({
          schema: Reading,
          objectName: "receipt",
          system: SYSTEM,
          prompt: JSON.stringify({ today: args.today }),
          files: [args.file],
        })
        if (!reading.readable) return yield* new Invalid({ message: "Aucun paiement trouvé dans ce document" })

        const cents = reading.amount === null || !Number.isFinite(reading.amount) ? null : Math.round(Math.abs(reading.amount) * 100)
        const currency = /^[A-Za-z]{3}$/.test(reading.currency) ? reading.currency.toUpperCase() : "EUR"
        let amount = cents
        let foreign: ReceiptDraft["foreign"] = null
        let notes = cleanText(reading.notes)
        if (cents !== null && currency !== "EUR") {
          // The rate missing costs the amount only: the rest of the reading is still worth showing.
          const rate = yield* market.euroRate(currency).pipe(Effect.orElseSucceed(() => null))
          amount = rate === null ? null : Math.round(cents * rate)
          foreign = { amount: cents, currency, rate }
          const original =
            rate === null
              ? `${formatForeign(cents, currency)} (taux indisponible)`
              : `${formatForeign(cents, currency)} à ${rate.toLocaleString("fr-FR", { maximumFractionDigits: 4 })}`
          notes = notes ? `${notes} · ${original}` : original
        }

        return {
          kind: reading.kind,
          amount: amount === 0 ? null : amount,
          payee: cleanText(reading.payee),
          date: reading.date !== null && isDay(reading.date) ? reading.date : null,
          notes,
          foreign,
        } satisfies ReceiptDraft
      })

      return Receipts.of({ read })
    }),
  )
}
