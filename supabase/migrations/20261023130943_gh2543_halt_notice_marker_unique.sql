CREATE UNIQUE INDEX IF NOT EXISTS notifications_contract_halt_notice_once_idx
  ON public.notifications (message_preview)
  WHERE notification_type = 'contract_halt_notice_sent';

COMMENT ON INDEX public.notifications_contract_halt_notice_once_idx IS
'gh-2543 / PR 2959: one contract_halt_notice_sent marker per envelope+role (message_preview = envelope=<id>;role=<role>). Makes the send-once marker race-proof: the second concurrent insert fails 23505 and that delivery sends nothing.';