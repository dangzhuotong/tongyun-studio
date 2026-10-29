-- Destructive rollback. NOT automatically executed.
-- First export all records and verify backup. If any records exist, prefer
-- reverting the consumer while keeping this additive table instead of DROP.
USE tongyun_pipeline;
SELECT COUNT(*) AS delivery_count FROM task_deliveries;
-- Only after explicit approval to discard the table:
-- DROP TABLE task_deliveries;
