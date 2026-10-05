import { type FormatOptions, formatMoney } from "~/domain/money"

/**
 * The "Dépensé" column of an expense category or group. The server sends spending as a positive
 * amount; the column shows it as money leaving the envelope, like the account register does.
 */
export const formatSpent = (spent: number, options?: FormatOptions) => formatMoney(-spent, options)
