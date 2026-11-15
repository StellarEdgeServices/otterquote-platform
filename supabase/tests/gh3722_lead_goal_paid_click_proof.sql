-- gh-3722 (P12) proof. NOT RUN BY THE AUTHOR (migration-as-file only).
-- Run as ONE batch wrapped in BEGIN ... ROLLBACK after
-- supabase/migrations/20261115172000_gh3722_lead_goal_events_paid_click.sql is applied. Never COMMIT.
-- Control (organic, real): lead 147641e5 -> lead_utm_source 'chatgpt.com', lead_paid_click false.
-- Pass (paid, synthetic): fbclid + utm_medium 'paid' -> lead_paid_click true.
-- Fill the <...> fixture values from an existing synthetic lead/claim pair before running.
BEGIN;

-- 1. organic control
SELECT lead_id, lead_utm_source, lead_utm_medium, lead_has_click_id, lead_paid_click, goal_type
  FROM public.lead_goal_events WHERE lead_id::text LIKE '147641e5%';

-- 2. paid pass: synthetic lead converted to a synthetic user with a parsed loss-sheet claim
-- INSERT INTO public.leads (..., utm_source, utm_medium, fbclid, is_synthetic, converted_user_id)
--   VALUES (..., 'facebook', 'paid', 'test-fbclid', true, '<synthetic user uuid>');
-- SELECT lead_utm_source, lead_utm_medium, lead_has_click_id, lead_paid_click
--   FROM public.lead_goal_events WHERE lead_id = '<new lead id>';  -- expect true / true

-- 3. columns and order
SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns
 WHERE table_schema='public' AND table_name='lead_goal_events';
-- expect: lead_id,converted_user_id,lead_source,lead_utm_campaign,lead_variant,claim_id,first_hover_order_at,loss_sheet_parsed_at,goal_at,goal_type,lead_utm_source,lead_utm_medium,lead_has_click_id,lead_paid_click

ROLLBACK;
