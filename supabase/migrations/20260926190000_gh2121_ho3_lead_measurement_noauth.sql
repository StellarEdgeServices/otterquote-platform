-- gh-2121 (HO-3, row 3.2): "$15 measurement / loss sheet without an account".
--
-- Ben's Ruling 1 (2026-09-26): this migration is additive-only -- new columns
-- or tables, all nullable, with a rollback file
-- (20260926190000_gh2121_ho3_lead_measurement_noauth_rollback.sql). Tier 3A,
-- autonomous: shipped in the PR, NOT applied by this worker. Go-live order is
-- migration -> merge -> EF deploys -> Stripe webhook branch (see PR body);
-- Ben applies this migration under Dustin's funnel authority before merge.
--
-- WHY A NEW leads.access_token RATHER THAN THE RAW lead id IN THE URL.
-- Ben's Ruling 3: lead access is by an unguessable per-lead token (>=128-bit
-- random), never the raw lead id, and it expires. router-variant-f.js's
-- thank-you screen already appends "?lead=<uuid>" to the two CTA links
-- (measure / loss_sheet) -- HO-3.S25's own stop condition (#2121 comment
-- 5849014575) calls out that a sequential/guessable identifier there is a
-- security kill condition, not a phased-response one. `leads.id` is a v4 UUID
-- (already unguessable on its own), but it is also the row's PRIMARY KEY and
-- appears in other operator-facing surfaces (ClickUp/GA4/Sentry breadcrumbs,
-- ATC handoffs, `set_lead_role`/`record_lead_details` RPC args) -- this
-- column gives HO-3 a SEPARATE, purpose-scoped, expiring credential instead
-- of overloading the primary key as a bearer token.
--
-- WHY TWO NEW TABLES RATHER THAN A NULLABLE lead_id ON hover_orders.
-- The HO-3 build spec (In Flight/reports/ceo71-ho-define-20260926.md, HO-3
-- build spec section) offered a choice: "a new lead_measurement_orders table
-- ... or, if minimal-diff is preferred, add a nullable lead_id column to the
-- existing measurement-orders table ... with a check constraint that exactly
-- one of the two is set." This migration takes the new-table branch:
-- hover_orders.claim_id has a NOT-optional FOREIGN KEY to claims(id) that
-- every existing reader (admin-measurements.html, create-measurement-order,
-- notify-measurement-order, the CAPI Purchase handler in stripe-webhook)
-- assumes is present, and hover_orders has no `is_test`/founder-exclusion
-- column of its own -- it is derived by joining out to claims.is_test
-- (see create-measurement-order/index.ts's recordOrderCreated). Loosening
-- hover_orders.claim_id to nullable is exactly the kind of "one deleted/NULL
-- column away from a silent readers-assume-non-null bug" pattern this
-- repo's own gh-1537/gh-2105 fixes were about. A same-shaped SIBLING table
-- keyed on lead_id, admin-fulfilled the same way hover_orders is, is
-- additive to hover_orders in the literal sense Ruling 1 asks for: nothing
-- about hover_orders (schema, constraints, or the code that reads it)
-- changes at all.
--
-- FOUNDER / TEST EXCLUSIONS, is_synthetic (Ben's Ruling 4): unchanged from
-- Arm F. `leads.is_synthetic` already exists (js/router-variant-f.js's own
-- header: "is_synthetic" is set on the anon insert same as every other Arm F
-- lead) and is read as-is by every new function in this PR -- no new
-- is_test/is_synthetic column is added here.

-- ── 1. Per-lead unguessable, expiring access token ─────────────────────────────
alter table public.leads
  add column if not exists access_token text,
  add column if not exists access_token_expires_at timestamptz;

comment on column public.leads.access_token is
  'gh-2121 HO-3: an unguessable (>=128-bit random, URL-safe base64) bearer credential for the no-account $15 measurement / loss-sheet-upload path. Minted by issue_lead_access_token(); never the raw leads.id. Null until minted.';
comment on column public.leads.access_token_expires_at is
  'gh-2121 HO-3: expiry for access_token (30 days from minting). A new/lead Edge Function must reject an expired token -- see resolve_lead_by_token().';

-- Sparse unique index: most leads never mint a token, so this stays small and
-- also gives resolve_lead_by_token() an index-backed lookup.
create unique index if not exists leads_access_token_key
  on public.leads (access_token)
  where access_token is not null;

-- ── 2. Lead-keyed measurement order (sibling of hover_orders, never touches it) ──
create table if not exists public.lead_measurement_orders (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id),
  status text not null default 'awaiting_fulfillment',
  product_code text not null default 'roof_basic',
  stripe_payment_intent_id text unique,
  homeowner_charge_amount integer,
  stripe_charge_id text,
  rebate_due boolean not null default true,
  admin_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.lead_measurement_orders is
  'gh-2121 HO-3: a paid $15 measurement report ordered against a lead that has no account yet. Mirrors hover_orders'' shape for a homeowner-purchased roof_basic report (see create-lead-measurement-order), but is a SEPARATE table so hover_orders and every existing reader of it are completely untouched (Ben''s Ruling 1). An admin fulfils these from the same operational discipline as hover_orders (manual, vendor-agnostic) -- a follow-up can surface them in the same admin tool or migrate a converted lead''s order into hover_orders once that lead becomes a claim.';

create index if not exists lead_measurement_orders_lead_id_idx
  on public.lead_measurement_orders (lead_id);

-- ── 3. Lead-keyed loss-sheet upload (no OCR/parse in this PR -- see PR body) ──
create table if not exists public.lead_loss_sheet_uploads (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id),
  storage_path text not null,
  original_filename text,
  content_type text,
  byte_size integer,
  status text not null default 'received',
  admin_notes text,
  created_at timestamptz not null default now()
);

comment on table public.lead_loss_sheet_uploads is
  'gh-2121 HO-3: an insurance loss sheet uploaded by a lead with no account. Stored under Storage bucket lead-loss-sheets/<lead_id>/... . Deliberately NOT auto-parsed by parse-loss-sheet in this PR -- that function is bound to claims.user_id ownership and writes to claims.* columns a lead does not have (see PR body, "not built"). An admin reviews status=''received'' rows by hand; a follow-up PR can parse once a claim exists for the lead.';

create index if not exists lead_loss_sheet_uploads_lead_id_idx
  on public.lead_loss_sheet_uploads (lead_id);

-- Private bucket, service-role access only (the same posture as claim-documents;
-- no anon/authenticated Storage policy is added because every read/write to this
-- bucket goes through a service-role Edge Function, never a direct client call).
insert into storage.buckets (id, name, public)
values ('lead-loss-sheets', 'lead-loss-sheets', false)
on conflict (id) do nothing;

-- ── 4. issue_lead_access_token(p_lead_id) ───────────────────────────────────
-- Mints (or, idempotently, returns) the access token for a lead. Callable
-- ONLY by service_role: the browser never calls this RPC directly -- it goes
-- through the issue-lead-access-token Edge Function (verify_jwt=false, like
-- record-lead-details), which is the thing that is actually reachable from
-- /start?v=f. The 30-minute "must still be a fresh, in-scope lead" window
-- mirrors record_lead_details()'s own scope check (same migration family,
-- 20260923211259_gh2122_leads_details_consent.sql) -- a token is minted right
-- after the thank-you screen appears, not arbitrarily later.
create or replace function public.issue_lead_access_token(p_lead_id uuid)
returns table (token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_created_at timestamptz;
  v_existing_token text;
  v_existing_expires timestamptz;
  v_new_token text;
  v_new_expires timestamptz;
begin
  select l.created_at, l.access_token, l.access_token_expires_at
    into v_created_at, v_existing_token, v_existing_expires
  from public.leads l
  where l.id = p_lead_id
  for update;

  if not found then
    return;
  end if;

  -- Idempotent: a retried mint request (e.g. the browser's own retry logic)
  -- returns the SAME token rather than rotating it out from under a request
  -- already in flight with the first one.
  if v_existing_token is not null and v_existing_expires is not null and v_existing_expires > now() then
    token := v_existing_token;
    expires_at := v_existing_expires;
    return next;
    return;
  end if;

  -- Out-of-scope lead (too old to be a fresh Arm F/HO-2 thank-you-screen
  -- visit): mint nothing. Mirrors record_lead_details()'s own "lead_out_of_scope"
  -- window rather than inventing a second one.
  if v_created_at is null or v_created_at < now() - interval '30 minutes' then
    return;
  end if;

  -- 24 random bytes = 192 bits, well over Ruling 3's >=128-bit floor.
  -- URL-safe base64 (RFC 4648 sec.5), padding stripped.
  v_new_token := translate(encode(gen_random_bytes(24), 'base64'), '+/=', '-_');
  v_new_token := rtrim(v_new_token, '-');
  v_new_expires := now() + interval '30 days';

  update public.leads
     set access_token = v_new_token,
         access_token_expires_at = v_new_expires
   where id = p_lead_id
     and access_token is null; -- first-write-wins; a concurrent minter (two tabs) never overwrites the other's token

  if found then
    token := v_new_token;
    expires_at := v_new_expires;
    return next;
    return;
  end if;

  -- Lost the race to a concurrent mint: return whatever the winner stored.
  select l.access_token, l.access_token_expires_at
    into v_existing_token, v_existing_expires
  from public.leads l
  where l.id = p_lead_id;

  token := v_existing_token;
  expires_at := v_existing_expires;
  return next;
end;
$$;

revoke all on function public.issue_lead_access_token(uuid) from public, anon, authenticated;
grant execute on function public.issue_lead_access_token(uuid) to service_role;

-- ── 5. resolve_lead_by_token(p_token) ─────────────────────────────────
-- The ONLY way any of this PR's new Edge Functions learn a lead_id from a
-- client-supplied value. Every new function calls this with the service-role
-- client and a client-supplied lead_token; it NEVER accepts or trusts a
-- client-supplied lead_id (Ben's Ruling 3 / the build spec's own "never trust
-- a client-supplied lead_id" line). An expired or unknown token resolves to
-- zero rows -- the caller then refuses with 401/403, never falls back to
-- guessing the lead.
create or replace function public.resolve_lead_by_token(p_token text)
returns table (
  lead_id uuid,
  email text,
  name text,
  phone text,
  is_synthetic boolean
)
language sql
security definer
stable
set search_path = public
as $$
  select l.id, l.email, l.name, l.phone, coalesce(l.is_synthetic, false)
  from public.leads l
  where l.access_token = p_token
    and l.access_token is not null
    and l.access_token_expires_at is not null
    and l.access_token_expires_at > now();
$$;

revoke all on function public.resolve_lead_by_token(text) from public, anon, authenticated;
grant execute on function public.resolve_lead_by_token(text) to service_role;

-- ── 6. Rate limits for the four new pre-auth Edge Functions ───────────────
-- Same discipline as record-lead-details' own migration: an explicit row so a
-- missing one is never silently covered by check_rate_limit()'s built-in
-- default. Per-IP synthetic-UUID buckets (mirrors record-lead-details'
-- ipToUuid pattern), so these are NOT per-lead limits.
insert into public.rate_limit_config (function_name, max_per_hour, max_per_day, max_per_month, enabled, notes)
values
  ('issue-lead-access-token', 60, 200, 2000, true,
   'gh-2121 HO-3: mints/returns a lead''s access token from the Arm F thank-you screen. Per-IP synthetic-UUID bucket, same pattern as record-lead-details.'),
  ('create-lead-payment-intent', 20, 100, 1000, true,
   'gh-2121 HO-3: creates the $15 Stripe PaymentIntent for a token-holding lead. Per-IP synthetic-UUID bucket.'),
  ('create-lead-measurement-order', 20, 100, 1000, true,
   'gh-2121 HO-3: records the paid lead-keyed measurement order after Stripe confirms. Per-IP synthetic-UUID bucket.'),
  ('record-lead-loss-sheet-upload', 20, 60, 600, true,
   'gh-2121 HO-3: stores a lead''s uploaded loss-sheet file. Per-IP synthetic-UUID bucket; file size is also capped in the handler.')
on conflict (function_name) do nothing;
