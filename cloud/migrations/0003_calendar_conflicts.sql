ALTER TABLE calendar_jobs ADD COLUMN sync_error TEXT;
ALTER TABLE calendar_jobs ADD COLUMN remote_conflict TEXT;
ALTER TABLE calendar_jobs ADD COLUMN confirmed_token TEXT;
