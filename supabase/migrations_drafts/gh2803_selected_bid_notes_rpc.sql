-- gh-2803 (D-381): update_selected_bid_notes(uuid, text), the notes-only save for a selected bid.
-- STATUS (gh-1438, as of 2026-10-18T18:56:17Z): NOT APPLIED
-- EVIDENCE: production read-only 2026-10-18: no update_selected_bid_notes in pg_proc; quotes.notes is text NULL; 0 selected bids on real claims, 3 selected bids, all is_test; fee_amount mismatches against round(platform_fee_pct/100*total_price,2): 0; quotes_guard_homeowner_columns() prosrc has no gh-2564 clause (gh2564 not applied)
-- REPO COPY: none in supabase/migrations/ (not applied). Rollback: supabase/migrations_drafts/gh2803_selected_bid_notes_rpc_rollback.sql  Pre-flight: supabase/migrations_drafts/gh2803_selected_bid_notes_rpc_pre-flight.md  Proof: supabase/tests/gh2803_selected_bid_notes_proof.sql
-- DO NOT RUN FROM THIS DIRECTORY: apply only through the Tier 3B path (review, R-177 if the gate is red, tier:3b-approved after the R-097 window ends 2026-10-19T18:37:39Z, recorded apply). Sequence AFTER gh2564 (PR #2802 is the page half of that lock).
--
-- WHY. PR #2802 hides the whole contractor bid form once the homeowner selects the bid, so a selected contractor
-- has no way to edit the notes, which D-381 says stay editable. The form saves notes only inside its one submit
-- handler, whose payload also carries price, fee, trade, value_adds and warranty. This adds ONE narrow
-- SECURITY DEFINER function that writes quotes.notes ("Message to Homeowner" on the form, maxlength 500) and nothing else.
--
-- WHAT IT ENFORCES (all inside the function, because a SECURITY DEFINER body runs as the function owner, so
-- quotes_guard_homeowner_columns(), which acts only when current_user is anon or authenticated, does not see this write):
--   * caller must be signed in; the quote must belong to a contractor row whose user_id = auth.uid()  (else 42501, same text for "no such quote" and "not yours")
--   * the quote must be status selected or awarded and bid_status active; any other bid is saved through the normal bid form
--   * notes are trimmed, an empty string becomes NULL, and more than 500 characters is refused (the form's own maxlength)
--   * the single UPDATE sets notes only. updated_at moves through set_updated_at_quotes. quotes_normalize_fee_amount
--     recomputes fee_amount from the stored pct and price, which is a no-op on every row today (0 mismatches).
-- COMPOSITION WITH gh2564: that draft locks price, fee and terms columns for client callers and leaves notes writable; this function
-- never touches those columns, so it neither depends on nor weakens that lock. Applied before or after gh2564, price/fee/trade/value_adds/warranty cannot move through it.
-- NOTE: with gh2564 applied, a direct client UPDATE of quotes.notes on a selected bid is also accepted by the guard (notes is in the contractor allow-list and not in the gh2564 lock list). This function is the form's path and the narrow one: it cannot be used to change anything else. See the pre-flight.
--
-- EXECUTE: new public functions get EXECUTE for PUBLIC/anon/authenticated/service_role by default, so all three are revoked explicitly and authenticated granted.
-- Idempotent: CREATE OR REPLACE FUNCTION. No table, trigger, policy or data change.
-- Rollback: supabase/migrations_drafts/gh2803_selected_bid_notes_rpc_rollback.sql
-- NOT APPLIED by the authoring session. Tier 3B (R-097 notice, issue #2803 comment 2026-10-18T18:38:42Z).

BEGIN;

CREATE OR REPLACE FUNCTION public.update_selected_bid_notes(p_quote_id uuid, p_notes text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid    uuid := auth.uid();
  v_status text;
  v_bid    text;
  v_notes  text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'update_selected_bid_notes: sign in to save notes' USING ERRCODE = '42501';
  END IF;

  SELECT q.status, q.bid_status INTO v_status, v_bid
    FROM public.quotes q
    JOIN public.contractors k ON k.id = q.contractor_id
   WHERE q.id = p_quote_id
     AND k.user_id = v_uid
     FOR UPDATE OF q;

  IF NOT FOUND THEN
    -- same message whether the quote does not exist or belongs to someone else
    RAISE EXCEPTION 'update_selected_bid_notes: no such bid for this contractor' USING ERRCODE = '42501';
  END IF;

  IF v_status NOT IN ('selected', 'awarded') OR COALESCE(v_bid, 'active') <> 'active' THEN
    RAISE EXCEPTION 'update_selected_bid_notes: this path is only for a bid the homeowner has selected; save other bids from the bid form'
      USING ERRCODE = '22023';
  END IF;

  v_notes := NULLIF(btrim(COALESCE(p_notes, '')), '');
  IF v_notes IS NOT NULL AND char_length(v_notes) > 500 THEN
    RAISE EXCEPTION 'update_selected_bid_notes: notes are limited to 500 characters' USING ERRCODE = '22001';
  END IF;

  UPDATE public.quotes SET notes = v_notes WHERE id = p_quote_id;

  RETURN v_notes;
END;
$fn$;

REVOKE ALL ON FUNCTION public.update_selected_bid_notes(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_selected_bid_notes(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.update_selected_bid_notes(uuid, text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.update_selected_bid_notes(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.update_selected_bid_notes(uuid, text) IS
  'gh-2803 / D-381: notes-only save for the contractor''s own selected (or awarded), active bid. Writes quotes.notes and nothing else; SECURITY DEFINER with a fixed search_path; EXECUTE to authenticated only. Refuses (42501) a caller who is not signed in or does not own the quote, (22023) a bid that is not selected, (22001) notes over 500 characters.';

COMMIT;
