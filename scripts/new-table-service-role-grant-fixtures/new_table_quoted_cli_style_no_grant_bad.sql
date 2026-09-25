-- GRANT-CHECK-FIXTURE: EXPECT=FAIL
-- Negative control (PR #2201 review 5839752411, finding 1): `supabase db
-- diff` emits CREATE TABLE with each identifier quoted separately --
-- "public"."foo" -- not one quoted span covering the dot. At 9b32febd,
-- the schema-then-dot group failed to match as a whole and the regex
-- fell through to capturing "public" itself as the table name. That
-- meant ANY grant whose target merely contained the schema-qualified
-- form `public.<anything>` -- see the unrelated grant on
-- `quoted_cli_style_other_widgets` below -- read as a word-match for a
-- table literally named "public" and false-PASSed this migration, even
-- though the real new table (`quoted_cli_style_widgets`) has no grant
-- of its own at all. Exact repro shape from the review:
-- `CREATE TABLE "public"."foo" (...); GRANT ALL ON public.bar TO service_role;`

BEGIN;

CREATE TABLE "public"."quoted_cli_style_widgets" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "quoted_cli_style_widgets_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "public"."quoted_cli_style_widgets" ENABLE ROW LEVEL SECURITY;

-- Unrelated table's grant. Must never be credited to the new table above
-- just because both targets are schema-qualified under "public".
grant select, insert, update, delete on public.quoted_cli_style_other_widgets to service_role;

COMMIT;
