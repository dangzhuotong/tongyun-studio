-- TiDB tongyun_pipeline. Additive migration: does not change tasks/task_runs.
USE tongyun_pipeline;

-- Preview before applying:
SELECT TABLE_NAME FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'task_deliveries';

CREATE TABLE task_deliveries (
  id BIGINT AUTO_RANDOM PRIMARY KEY,
  task_id BIGINT NOT NULL,
  run_id BIGINT NULL,
  version INT UNSIGNED NOT NULL,
  request_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(255) NOT NULL,
  summary TEXT NOT NULL,
  html_content MEDIUMTEXT NOT NULL,
  content_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  content_bytes INT UNSIGNED NOT NULL,
  acceptance_version INT UNSIGNED NOT NULL,
  created_by VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_delivery_task_version (task_id, version),
  UNIQUE KEY uk_delivery_task_request (task_id, request_id),
  KEY idx_delivery_run (run_id),
  KEY idx_delivery_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- Verify:
SHOW COLUMNS FROM task_deliveries;
SHOW INDEX FROM task_deliveries;
