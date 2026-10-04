import type { ValuationSource } from "~/server/db/schema"
import { cx } from "./ui"

const CREDITS = {
  coingecko: { prefix: "", label: "Powered by CoinGecko", href: "https://www.coingecko.com/" },
  dvf: { prefix: "Source : ", label: "Statistiques DVF, data.gouv.fr (ODbL)", href: "https://www.data.gouv.fr/fr/datasets/statistiques-dvf/" },
} as const

export type CreditedSource = keyof typeof CREDITS

/** The provider whose terms ask to be credited wherever its figures appear, if any. */
export const creditOf = (source: ValuationSource | null | undefined): CreditedSource | null =>
  source?.kind === "crypto" ? "coingecko" : source?.kind === "real_estate" ? "dvf" : null

export const DataCredit = ({ source, className }: { source: CreditedSource; className?: string }) => {
  const credit = CREDITS[source]
  return (
    <span className={cx("text-[11px] text-faint", className)}>
      {credit.prefix}
      <a href={credit.href} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:text-fg hover:underline">
        {credit.label}
      </a>
    </span>
  )
}
