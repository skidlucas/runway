-- A loan is now dated by its first installment, which fell one month after the old start date (clamped to the month's end).
UPDATE `assets`
SET `source` = json_remove(
  json_set(
    `source`,
    '$.firstPaymentDate',
    min(
      date(json_extract(`source`, '$.startDate'), '+1 month'),
      date(json_extract(`source`, '$.startDate'), 'start of month', '+2 months', '-1 day')
    )
  ),
  '$.startDate'
)
WHERE json_extract(`source`, '$.kind') = 'loan' AND json_extract(`source`, '$.startDate') IS NOT NULL;
