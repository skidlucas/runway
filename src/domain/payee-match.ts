import { normalizeText } from "./rules"

export type PayeeCandidate = { readonly id: string; readonly name: string; readonly transferAccountId: string | null }

// Words that tell nothing about who the payee is: legal forms, countries, web suffixes.
const NOISE = new Set([
  "sa", "sas", "sasu", "sarl", "eurl", "sci", "snc", "gmbh", "ag", "ltd", "limited", "inc", "llc", "plc", "bv", "nv", "srl", "spa",
  "co", "cie", "et", "the", "eu", "europe", "france", "fr", "www", "com", "net", "org",
])

const words = (name: string) => {
  const all = normalizeText(name).split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const meaningful = all.filter((w) => !NOISE.has(w))
  return meaningful.length > 0 ? meaningful : all
}

// Letters a misreading may get wrong: none on short names, where one letter makes another word.
const allowedTypos = (length: number) => (length >= 12 ? 2 : length >= 6 ? 1 : 0)

/** Edit distance between `a` and `b`, or `max + 1` as soon as it is known to exceed `max`. */
const distanceWithin = (a: string, b: string, max: number) => {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
      current.push(value)
      rowMin = Math.min(rowMin, value)
    }
    if (rowMin > max) return max + 1
    previous = current
  }
  return previous[b.length]!
}

/** The best candidate by `score`, or null when none scores or the best two tie. */
const unique = <T>(items: ReadonlyArray<T>, score: (item: T) => number) => {
  let best: T | null = null
  let bestScore = 0
  let tied = false
  for (const item of items) {
    const s = score(item)
    if (s > bestScore) {
      best = item
      bestScore = s
      tied = false
    } else if (s === bestScore && s > 0) {
      tied = true
    }
  }
  return tied ? null : best
}

/**
 * Finds the existing payee a name read on a document refers to, from the strictest test to the
 * loosest: same name, same name once legal forms and the like are dropped, every word of one
 * name in the other ("Free Mobile" in "PRLV SEPA FREE MOBILE"), then a spelling one or two
 * letters away. A tie at any step means a guess: no payee is picked, and the name is offered as
 * a new one instead.
 */
export function matchPayee<P extends PayeeCandidate>(name: string, payees: ReadonlyArray<P>): P | null {
  const read = normalizeText(name)
  if (read === "") return null
  const candidates = payees.filter((p) => p.transferAccountId === null)

  const exact = candidates.filter((p) => normalizeText(p.name) === read)
  if (exact.length > 0) return exact.length === 1 ? exact[0]! : null

  const readWords = words(name)
  const readKey = readWords.join(" ")
  const indexed = candidates.map((p) => {
    const w = words(p.name)
    return { payee: p, words: w, set: new Set(w), key: w.join(" ") }
  })

  const sameKey = indexed.filter((c) => c.key === readKey)
  if (sameKey.length > 0) return sameKey.length === 1 ? sameKey[0]!.payee : null

  const readSet = new Set(readWords)
  const contained = unique(indexed, (c) => {
    const [small, large] = c.set.size <= readSet.size ? [c.set, readSet] : [readSet, c.set]
    // A lone short word ("bp", "u") would match far too many names.
    if ([...small].join("").length < 3) return 0
    for (const w of small) if (!large.has(w)) return 0
    return small.size
  })
  if (contained) return contained.payee

  const typos = allowedTypos(readKey.length)
  const close = unique(indexed, (c) => {
    if (typos === 0) return 0
    const distance = distanceWithin(readKey, c.key, typos)
    return distance <= typos ? typos + 1 - distance : 0
  })
  return close?.payee ?? null
}
