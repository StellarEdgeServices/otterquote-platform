-- Rollback: Remove wc_cert_reminder_30_sent_at column added for D-210 WC cert reminder idempotency
ALTER TABLE contractors DROP COLUMN IF EXISTS wc_cert_reminder_30_sent_at;
