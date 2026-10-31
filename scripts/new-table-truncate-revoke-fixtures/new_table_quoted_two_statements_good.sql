-- TRUNCATE-CHECK-FIXTURE: EXPECT=PASS
-- CLI-quoted identifiers, roles revoked in two separate statements.
CREATE TABLE "public"."gh3256_things" ("id" uuid NOT NULL);
REVOKE TRUNCATE ON TABLE "public"."gh3256_things" FROM "anon";
REVOKE TRUNCATE ON TABLE "public"."gh3256_things" FROM "authenticated";
