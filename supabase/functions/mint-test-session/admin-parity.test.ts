// gh-3077 (replaces the gh-2410 parity test). mint-test-session's admin REFUSAL list used to be a literal copy
// (ADMIN_EMAILS_LOWER) of _shared/admin.ts ADMIN_EMAILS. Both are gone: the list is now the rows of public.admin_emails,
// read by DbAdapter.getAdminEmails(), matched by emailInAdminList().
// Run: deno test --allow-read=supabase/functions,supabase/migrations_drafts,supabase/migrations supabase/functions/mint-test-session/admin-parity.test.ts
//
// What this proves:
//   1. EQUIVALENCE: for the seed rows of admin_emails (read from the migration file, not retyped), the new matcher
//      refuses exactly the targets the old inlined list refused, over a corpus of case/whitespace/near-miss variants.
//   2. The email refusal still runs before the DB role-signal read, inside adminRefusal().
//   3. NEGATIVE CONTROLS: an emptied list, or a list missing one address, FAILS the equivalence; source with the
//      refusal call removed FAILS the structure check; and gate.ts carries no email literal.
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { emailInAdminList } from "./gate.ts";

// The pre-gh-3077 behaviour, kept here verbatim as the reference the new code must equal.
const OLD_ADMIN_EMAILS_LOWER: readonly string[] = ["dustinstohler1@gmail.com", "dustin@otterquote.com"];
const oldRefuses = (email: string) => OLD_ADMIN_EMAILS_LOWER.includes(email.trim().toLowerCase());

async function readSeedRows(): Promise<string[]> {
  for (const dir of ["migrations_drafts", "migrations"]) {
    try {
      const sql = await Deno.readTextFile(new URL(`../../${dir}/gh3009_admin_emails_table.sql`, import.meta.url));
      const block = sql.match(/INSERT INTO public\.admin_emails[^;]*;/);
      if (!block) continue;
      return [...block[0].matchAll(/\(\s*'([^']+)'\s*,/g)].map((m) => m[1]);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
  throw new Error("gh3009_admin_emails_table.sql seed block not found in migrations_drafts or migrations");
}

const CORPUS = [
  "dustinstohler1@gmail.com", "dustin@otterquote.com",
  "  DustinStohler1@Gmail.com ", "DUSTIN@OTTERQUOTE.COM", "\tdustin@otterquote.com\n",
  "dustinstohler1@gmail.com.evil.test", "xdustin@otterquote.com", "dustin@otterquote.co",
  "dustin+tag@otterquote.com", "someone@otterquote-internal.test", "test-contractor@example.com", "", "   ",
];

Deno.test("gh-3077: the admin_emails seed rows are exactly the old refusal list", async () => {
  assertEquals([...(await readSeedRows())].sort(), [...OLD_ADMIN_EMAILS_LOWER].sort());
});

Deno.test("gh-3077: emailInAdminList(seed rows) refuses exactly what the old inlined list refused, over the whole corpus", async () => {
  const rows = await readSeedRows();
  for (const e of CORPUS) assertEquals(emailInAdminList(rows, e), oldRefuses(e), `target ${JSON.stringify(e)}`);
});

Deno.test("gh-3077: a non-admin is NOT refused by the email arm; an admin is", async () => {
  const rows = await readSeedRows();
  assertFalse(emailInAdminList(rows, "someone@otterquote-internal.test"));
  assert(emailInAdminList(rows, "dustin@otterquote.com"));
});

Deno.test("gh-3077: adminRefusal() reads the list and refuses on it before the DB role-signal read", async () => {
  const src = await Deno.readTextFile(new URL("./gate.ts", import.meta.url));
  const fn = src.indexOf("async function adminRefusal(");
  assert(fn >= 0, "adminRefusal() not found in gate.ts");
  const listRead = src.indexOf("db.getAdminEmails(", fn);
  const match = src.indexOf("emailInAdminList(adminEmails", fn);
  const signalRead = src.indexOf("db.getAdminSignals(", fn);
  assert(listRead > fn && match > listRead && signalRead > match, "order must be: list read, email refusal, role-signal read");
});

Deno.test("gh-3077: gate.ts and index.ts carry no admin email literal", async () => {
  for (const f of ["./gate.ts", "./index.ts"]) {
    const src = await Deno.readTextFile(new URL(f, import.meta.url));
    assertFalse(/dustinstohler1@gmail\.com|dustin@otterquote\.com/.test(src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")), `${f} has an email literal in code`);
  }
});

// ── negative controls ──
Deno.test("gh-3077 negative control: an emptied list refuses nobody, so the equivalence FAILS", () => {
  assert(oldRefuses("dustin@otterquote.com"));
  assertFalse(emailInAdminList([], "dustin@otterquote.com"), "an empty list admits the admin target: the corpus check above would fail");
});

Deno.test("gh-3077 negative control: a list missing one address FAILS the equivalence for that address", () => {
  assert(oldRefuses("dustin@otterquote.com") !== emailInAdminList(["dustinstohler1@gmail.com"], "dustin@otterquote.com"));
});

Deno.test("gh-3077 negative control: gate.ts with the refusal call removed FAILS the structure check", async () => {
  const src = await Deno.readTextFile(new URL("./gate.ts", import.meta.url));
  const broken = src.replace("emailInAdminList(adminEmails", "false && (adminEmails");
  assert(broken !== src);
  assertEquals(broken.indexOf("emailInAdminList(adminEmails", broken.indexOf("async function adminRefusal(")), -1);
});
