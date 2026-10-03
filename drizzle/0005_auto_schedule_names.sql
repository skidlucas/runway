-- Schedules imported from Actual before this fix kept the name Actual generates for them.
UPDATE schedules SET name = NULL WHERE name LIKE 'Auto-created future transaction (%';
