-- GRANT-CHECK-FIXTURE: EXPECT=PASS
-- Positive control mirroring the fixture above: same CLI-quoted
-- `"public"."foo"` CREATE TABLE shape, but this one carries an explicit,
-- correctly-quoted service_role grant naming the real table -- must PASS
-- now that the table name is parsed correctly instead of as "public".

BEGIN;

CREATE TABLE "public"."quoted_cli_style_widgets" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "quoted_cli_style_widgets_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "public"."quoted_cli_style_widgets" ENABLE ROW LEVEL SECURITY;

grant select, insert, update, delete on "public"."quoted_cli_style_widgets" to service_role;

COMMIT;
