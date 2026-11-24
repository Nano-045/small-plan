ALTER TABLE bridge_requests ADD COLUMN automatic INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bridge_requests ADD COLUMN finished_at INTEGER;
UPDATE bridge_requests SET finished_at=created WHERE status IN ('failed','done');
CREATE INDEX bridge_kind_finished ON bridge_requests(kind,finished_at);
