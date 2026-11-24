ALTER TABLE calendar_jobs ADD COLUMN last_attempt INTEGER NOT NULL DEFAULT 0;
CREATE INDEX calendar_attempt_order ON calendar_jobs(last_attempt);
ALTER TABLE bridge_requests ADD COLUMN calendar_run INTEGER;
