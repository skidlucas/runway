import { describe, expect, it } from "vitest"
import { matchPayee, type PayeeCandidate } from "~/domain/payee-match"

const payees = (...names: string[]): PayeeCandidate[] => names.map((name, i) => ({ id: `p${i}`, name, transferAccountId: null }))
const matched = (name: string, list: PayeeCandidate[]) => matchPayee(name, list)?.name ?? null

describe("matchPayee", () => {
  it("matches the same name whatever the case and accents", () => {
    expect(matched("CAFÉ de la gare", payees("Café de la Gare", "Gare du Nord"))).toBe("Café de la Gare")
  })

  it("ignores legal forms and web suffixes", () => {
    expect(matched("Amazon EU S.à r.l.", payees("Amazon", "Amazon Prime"))).toBe("Amazon")
    expect(matched("Leboncoin.fr", payees("Leboncoin"))).toBe("Leboncoin")
  })

  it("matches a name contained in a longer one, both ways", () => {
    expect(matched("Free Mobile", payees("PRLV SEPA FREE MOBILE", "Free"))).toBe("PRLV SEPA FREE MOBILE")
    expect(matched("Amazon Prime Video", payees("Amazon", "Amazon Prime"))).toBe("Amazon Prime")
  })

  it("picks nothing when several payees match as well", () => {
    expect(matched("Amazon", payees("Amazon Prime", "Amazon Music"))).toBeNull()
  })

  it("does not match on a lone short word", () => {
    expect(matched("BP", payees("BP Station Lyon"))).toBeNull()
  })

  it("tolerates a misread letter", () => {
    expect(matched("Decathlom", payees("Decathlon", "Darty"))).toBe("Decathlon")
  })

  it("leaves an unknown name unmatched", () => {
    expect(matched("Boulangerie Paul", payees("Carrefour", "Decathlon"))).toBeNull()
  })

  it("never picks a transfer payee", () => {
    expect(matchPayee("Livret A", [{ id: "t", name: "Livret A", transferAccountId: "acc" }])).toBeNull()
  })
})
