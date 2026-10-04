// SQL conditions shared by every query that has to agree on what a transaction means for the
// budget. They expect `t` to be the transactions row.

/**
 * A transfer between two accounts on the same side of the budget (both budgeted, or both off
 * budget): it moves money without spending or earning any, so it never carries a category.
 */
export const IS_INTERNAL_TRANSFER = `EXISTS (
  SELECT 1 FROM payees tp
  JOIN accounts tto ON tto.id = tp.transfer_account_id
  JOIN accounts tfrom ON tfrom.id = t.account_id
  WHERE tp.id = t.payee_id AND tto.off_budget = tfrom.off_budget)`
