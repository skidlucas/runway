// SQL conditions shared by every query that has to agree on what a transaction means for the
// budget. They expect `t` to be the transactions row; some also need its account as `a` and its
// payee as `p` (LEFT JOIN), as noted.

/**
 * A transfer between two accounts on the same side of the budget (both budgeted, or both off
 * budget): it moves money without spending or earning any, so it never carries a category.
 */
export const IS_INTERNAL_TRANSFER = `EXISTS (
  SELECT 1 FROM payees tp
  JOIN accounts tto ON tto.id = tp.transfer_account_id
  JOIN accounts tfrom ON tfrom.id = t.account_id
  WHERE tp.id = t.payee_id AND tto.off_budget = tfrom.off_budget)`

/** Lines the budget reads: those of budgeted accounts, without split parents (their lines carry the categories). Needs `a`. */
export const BUDGET_LINE = "a.off_budget = 0 AND t.is_parent = 0"

/**
 * BUDGET_LINE without joining the account: SQLite then reads each line once, where a join reads
 * the account again for every line.
 */
export const BUDGET_LINE_ALONE = "t.account_id IN (SELECT id FROM accounts WHERE off_budget = 0) AND t.is_parent = 0"

/**
 * "Counts for the budget": a budget line that moves money in or out of the budget. A transfer
 * between two budgeted accounts moves nothing; one to an off-budget account (savings kept apart,
 * a broker, a loan) is spent or earned like a purchase or a salary, and needs a category like
 * them. Needs `a` and `p`.
 */
export const COUNTS_FOR_BUDGET = `${BUDGET_LINE}
  AND (p.transfer_account_id IS NULL OR EXISTS (SELECT 1 FROM accounts o WHERE o.id = p.transfer_account_id AND o.off_budget = 1))`

/**
 * A budget line that is money earned or spent in its month. A starting balance funds the budget
 * (it is income there) but was not received that month. Needs `a`.
 */
export const BUDGET_CASH_FLOW = `${BUDGET_LINE} AND t.starting_balance = 0`

/** Counts for the budget but has no category yet: what the budget asks to categorize. Needs `a` and `p`. */
export const UNCATEGORIZED = `t.category_id IS NULL AND t.starting_balance = 0 AND ${COUNTS_FOR_BUDGET}`

/** Uncategorized lines a rule can categorize: rules never apply to transfers or split parents. */
export const RULE_CANDIDATE = "t.category_id IS NULL AND t.is_parent = 0 AND t.transfer_id IS NULL"
