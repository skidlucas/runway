export const ACCOUNT_KINDS = ["checking", "savings", "credit", "investment", "other"] as const
export type AccountKind = (typeof ACCOUNT_KINDS)[number]
