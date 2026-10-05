-- Support lease renewals up to 3 times per share
ALTER TABLE shares ADD COLUMN renewals_count INTEGER NOT NULL DEFAULT 0;
