-- Proposal only. Not executed. Check for an equivalent table before creating.
USE tongyun_pipeline;
SELECT TABLE_NAME FROM information_schema.TABLES
WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='task_delivery_reviews';
CREATE TABLE task_delivery_reviews (
 id BIGINT AUTO_RANDOM PRIMARY KEY,
 delivery_id BIGINT NOT NULL,
 task_id BIGINT NOT NULL,
 acceptance_version INT UNSIGNED NOT NULL,
 verdict ENUM('accepted','changes_requested') NOT NULL,
 comment TEXT NOT NULL,
 reviewed_by VARCHAR(64) NOT NULL,
 request_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 UNIQUE KEY uk_review_request (task_id,request_id),
 KEY idx_review_delivery (delivery_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
-- Associations and reviewer authorization must be checked by the service.
-- Rollback: export rows and verify the backup first; prefer keeping append-only
-- history. DROP is not automatic and requires explicit destructive authorization.
-- DROP TABLE task_delivery_reviews;
