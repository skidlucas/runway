export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

const integer = new Intl.NumberFormat("fr-FR")

/** French plural: 0 and 1 take the singular ("0 opération", "1 opération", "2 opérations"). */
export const plural = (n: number, one: string, many = `${one}s`) => (Math.abs(n) > 1 ? many : one)

/** "1 opération", "12 345 opérations". */
export const count = (n: number, one: string, many?: string) => `${integer.format(n)} ${plural(n, one, many)}`
