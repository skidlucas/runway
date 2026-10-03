-- Ended schedules now keep the first day they have not covered instead of their last booked occurrence.
UPDATE schedules SET next_date = date(next_date, '+1 day')
WHERE active = 0 AND EXISTS (SELECT 1 FROM transactions t WHERE t.schedule_id = schedules.id AND t.date = schedules.next_date);
