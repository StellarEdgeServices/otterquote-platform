-- gh-2121 (HO-3, row 3.2): "$15 measurement / loss sheet without an account".
--
-- Ben's Ruling 1 (2026-09-26): additive-only -- new tables, functions and
-- config rows; nothing existing is altered. Rollback file:
-- supabase/migrations_rollbacks/20260926190000_gh2121_ho3_lead_measurement_noauth_rollback.sql
-- (kept OUT of supabase/migrations/ so no applier ever runs it as a migration --
-- PR #2226 REVIEW D9).
--
-- Shipped in the PR, NOT applied by the author. Go-live order (PR #2226 REVIEW,
-- accepted order): fix + CI green -> apply THIS migration + run
-- supabase/tests/gh2121_ho3_lead_token_proof.sql -> deploy the four Edge
-- Functions -> deploy stripe-webhook + notify-measurement-order -> merge (Netlify
-- ships the router and pages LAST) -> live $15 smoke on a founder card + refund.
--
-- ── WHAT CHANGED IN THE FIX ROUND (PR #2226 REVIEW 5849589214) ─────────────────
--  D1  both new tables: RLS on, all privileges revoked from PUBLIC/anon/
--      authenticated, service_role granted EXPLICITLY. Supabase's default ACL on
--      `public` grants anon/authenticated arwdDxtm on every new table, so
--      without this anyone holding the publishable key could read or forge
--      orders.
--  D2  gen_random_bytes lives in schema `extensions` on this project;
--      the function now calls extensions.gen_random_bytes(24) explicitly.
--  D3  the freshness (30-minute) check now runs FIRST. There is no "return
--      the existing token" branch any more: only a hash is stored (D12), so
--      the plaintext cannot be handed back, and a lead older than 30 minutes
--      can never obtain a token no matter who asks.
--  D12 tokens live in a NEW table, lead_access_tokens, holding ONLY
--      sha256(token) -- never the plaintext -- with RLS on and no anon/
--      authenticated privileges. The `leads` table is NOT touched at all (the
--      first draft added leads.access_token, which anon could set to any
--      value through the live "Allow anonymous inserts" WITH CHECK (true)
--      policy, and which admins could read in plaintext via
--      leads_admin_select).
--  D13 the Storage bucket is created with file_size_limit = 6 MiB and the
--      four allowed MIME types.
--  D11 both new tables carry is_test, written from leads.is_synthetic.
--  L2  lead_measurement_orders.rebate_due defaults to FALSE: the D-291 rebate
--      path (process-hover-rebate) runs on hover_orders/claims only, and
--      nothing links a lead order to a later claim, so this flow must not
--      promise or flag a rebate it cannot pay. Tier C question on the PR.
--
-- WHY TWO NEW ORDER/UPLOAD TABLES RATHER THAN A NULLABLE lead_id ON hover_orders:
-- hover_orders.claim_id has a hard FK to claims(id) that every existing reader
-- (admin-measurements.html, create-measurement-order, notify-measurement-order,
-- the CAPI Purchase handler) assumes is present. A sibling table keyed on
-- lead_id leaves hover_orders and all of its readers untouched.

-- ── 1. Per-lead access tokens (hash only) ─────────────────────────────────────
create table if not exists public.lead_access_tokens (
  token_sha256 text primary key,
  lead_id uuid not null references public.leads(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint lead_access_tokens_sha256_hex check (token_sha256 ~ '^[0-9a-f]{64}$')
);

comment on table public.lead_access_tokens is
  'gh-2121 HO-3: bearer credentials for the no-account $15 measurement / loss-sheet pages. ONLY sha256(token) is stored (hex); the plaintext exists only in the mint response and the visitor''s URL fragment. Minted by issue_lead_access_token() (only for a lead created in the last 30 minutes, at most 5 per lead), resolved by resolve_lead_by_token(). RLS on, no policy; service_role only.';

create index if not exists lead_access_tokens_lead_id_idx
  on public.lead_access_tokens (lead_id);

alter table public.lead_access_tokens enable row level security;
revoke all on table public.lead_access_tokens from public, anon, authenticated;
grant select, insert, delete on table public.lead_access_tokens to service_role;

-- ── 2. Lead-keyed measurement order (sibling of hover_orders) ─────────────────
create table if not exists public.lead_measurement_orders (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id),
  status text not null default 'awaiting_fulfillment',
  product_code text not null default 'roof_basic',
  stripe_payment_intent_id text not null unique,
  homeowner_charge_amount integer not null,
  currency text not null default 'usd',
  stripe_charge_id text,
  rebate_due boolean not null default false,
  is_test boolean not null default false,
  recorded_by text not null default 'browser',
  admin_notified_at timestamptz,
  admin_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lead_measurement_orders_status_check
    check (status in ('awaiting_fulfillment', 'fulfilled', 'cancelled', 'refunded')),
  constraint lead_measurement_orders_recorded_by_check
    check (recorded_by in ('browser', 'webhook'))
);

comment on table public.lead_measurement_orders is
  'gh-2121 HO-3: a paid measurement report ordered by a lead with no account. Written ONLY by service-role code: create-lead-measurement-order (browser path, after Stripe confirms) and stripe-webhook (payment_intent.succeeded, metadata.type=lead_measurement_order) -- both insert ON CONFLICT (stripe_payment_intent_id) DO NOTHING, so a charge always gets exactly one row even if the tab closes. Separate from hover_orders so hover_orders and its readers are untouched.';
comment on column public.lead_measurement_orders.rebate_due is
  'gh-2121 HO-3 / PR #2226 L2: FALSE for lead orders. The D-291 rebate path runs on hover_orders/claims only; no lead-order -> claim linkage exists. Changing this is a D-number call for Dustin.';
comment on column public.lead_measurement_orders.admin_notified_at is
  'Set by notify-measurement-order (lead_order branch) when the admin email is sent; the idempotency key for that email.';

create index if not exists lead_measurement_orders_lead_id_idx
  on public.lead_measurement_orders (lead_id);

alter table public.lead_measurement_orders enable row level security;
revoke all on table public.lead_measurement_orders from public, anon, authenticated;
grant all on table public.lead_measurement_orders to service_role;

-- No anon/authenticated policy or grant: admins see these rows through the
-- service-role admin email (notify-measurement-order) and SQL. An admin UI is
-- a follow-up (it would need a SELECT grant to authenticated, which the
-- permissions ratchet deliberately makes a separate, reviewed change).

-- ── 3. Lead-keyed loss-sheet upload (no OCR/parse in this PR) ─────────────────
create table if not exists public.lead_loss_sheet_uploads (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id),
  storage_path text not null,
  original_filename text,
  content_type text not null,
  byte_size integer not null,
  status text not null default 'received',
  is_test boolean not null default false,
  admin_notified_at timestamptz,
  admin_notes text,
  created_at timestamptz not null default now(),
  constraint lead_loss_sheet_uploads_content_type_check
    check (content_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/heic')),
  constraint lead_loss_sheet_uploads_byte_size_check
    check (byte_size > 0 and byte_size <= 6291456)
);

comment on table public.lead_loss_sheet_uploads is
  'gh-2121 HO-3: an insurance loss sheet uploaded by a lead with no account, stored under Storage bucket lead-loss-sheets/<lead_id>/... . content_type is SERVER-SNIFFED from the file''s magic bytes, never the client''s claim. Not auto-parsed (parse-loss-sheet is claims-bound); an admin reviews status=''received'' rows by hand.';

create index if not exists lead_loss_sheet_uploads_lead_id_idx
  on public.lead_loss_sheet_uploads (lead_id);

alter table public.lead_loss_sheet_uploads enable row level security;
revoke all on table public.lead_loss_sheet_uploads from public, anon, authenticated;
grant all on table public.lead_loss_sheet_uploads to service_role;


-- Private bucket, service-role access only (no Storage policy is added: every
-- read/write goes through a service-role Edge Function). Size and type limits
-- are enforced by Storage itself as a second layer behind the handler (D13).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'lead-loss-sheets', 'lead-loss-sheets', false, 6291456,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/heic']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ── 4. issue_lead_access_token(p_lead_id) ───────────────────────────────────
-- Mints a NEW token for a lead created in the last 30 minutes. Callable ONLY by
-- service_role (via the issue-lead-access-token Edge Function). The freshness
-- check runs FIRST and there is no "hand back the existing token" branch, so
-- knowing a lead's UUID after its 30-minute window yields nothing (D3). At most
-- 5 live tokens per lead, so a UUID holder inside the window cannot mint
-- without bound. Returns zero rows when refused.
create or replace function public.issue_lead_access_token(p_lead_id uuid)
returns table (token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_created_at timestamptz;
  v_live_count integer;
  v_token text;
  v_expires timestamptz;
begin
  if p_lead_id is null then
    return;
  end if;

  select l.created_at into v_created_at
  from public.leads l
  where l.id = p_lead_id
  for update;

  if not found then
    return;
  end if;

  -- D3: freshness FIRST. Mirrors record_lead_details()'s 30-minute scope.
  if v_created_at is null or v_created_at < now() - interval '30 minutes' then
    return;
  end if;

  select count(*) into v_live_count
  from public.lead_access_tokens t
  where t.lead_id = p_lead_id
    and t.expires_at > now();
  if v_live_count >= 5 then
    return;
  end if;

  -- D2: pgcrypto is installed in schema `extensions` on this project.
  -- 24 random bytes = 192 bits; URL-safe base64 (RFC 4648 sec. 5). 24 bytes
  -- encode to exactly 32 characters with no padding and no line break.
  v_token := translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/', '-_');
  v_expires := now() + interval '30 days';

  insert into public.lead_access_tokens (token_sha256, lead_id, expires_at)
  values (encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), p_lead_id, v_expires);

  token := v_token;
  expires_at := v_expires;
  return next;
end;
$$;

revoke all on function public.issue_lead_access_token(uuid) from public, anon, authenticated;
grant execute on function public.issue_lead_access_token(uuid) to service_role;

-- ── 5. resolve_lead_by_token(p_token) ─────────────────────────────────────────
-- The ONLY way this feature's Edge Functions learn a lead_id from a
-- client-supplied value. Hashes its input and matches the stored hash; an
-- unknown or expired token resolves to zero rows.
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
set search_path = public, pg_temp
as $$
  select l.id, l.email, l.name, l.phone, coalesce(l.is_synthetic, false)
  from public.lead_access_tokens t
  join public.leads l on l.id = t.lead_id
  where p_token is not null
    and length(p_token) between 16 and 512
    and t.token_sha256 = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
    and t.expires_at > now();
$$;

revoke all on function public.resolve_lead_by_token(text) from public, anon, authenticated;
grant execute on function public.resolve_lead_by_token(text) to service_role;

-- ── 6. Rate limits for the four new pre-auth Edge Functions ───────────────────
-- Explicit rows so a missing one is never silently covered by
-- check_rate_limit()'s built-in default. Per-IP synthetic-UUID buckets. All four
-- functions FAIL CLOSED when the check itself errors.
insert into public.rate_limit_config (function_name, max_per_hour, max_per_day, max_per_month, enabled, notes)
values
  ('issue-lead-access-token', 60, 200, 2000, true,
   'gh-2121 HO-3: mints a lead access token from the Arm F thank-you screen. Per-IP synthetic-UUID bucket. Fails closed (the router then falls back to the authed pages).'),
  ('create-lead-payment-intent', 20, 100, 1000, true,
   'gh-2121 HO-3: price preview + Stripe PaymentIntent create for a token-holding lead. Per-IP synthetic-UUID bucket. Fails closed.'),
  ('create-lead-measurement-order', 20, 100, 1000, true,
   'gh-2121 HO-3: records the paid lead-keyed measurement order after Stripe confirms (the webhook also records it). Per-IP synthetic-UUID bucket. Fails closed.'),
  ('record-lead-loss-sheet-upload', 20, 60, 600, true,
   'gh-2121 HO-3: stores a lead''s uploaded loss-sheet file. Per-IP synthetic-UUID bucket; size/type also capped in the handler and on the bucket. Fails closed.')
on conflict (function_name) do nothing;
