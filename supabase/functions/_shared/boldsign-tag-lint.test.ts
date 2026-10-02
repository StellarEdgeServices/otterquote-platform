// gh-1314 — the labeled sign/init/date tag rule, with negative controls beside every pass.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { describeLabeledSignTags, findLabeledSignTags } from "./boldsign-tag-lint.ts";

Deno.test("lint: empty-label sign/init/date are accepted (the measured-working form)", () => {
  const t = "{{sign|1|*||contractor_signature}} {{date|1|*||contractor_signature_date}} {{init|2|*||homeowner_initial_sow}}";
  assertEquals(findLabeledSignTags(t), []);
});

Deno.test("lint: labeled sign / date / init are each rejected, naming the tag and the fixed form (negative control)", () => {
  const cases: Array<[string, string]> = [
    ["{{sign|1|*|Contractor Signature|contractor_signature}}", "{{sign|1|*||contractor_signature}}"],
    ["{{date|2|*|Homeowner Sign Date|homeowner_signature_date}}", "{{date|2|*||homeowner_signature_date}}"],
    ["{{init|1|*|Initials|contractor_initial_sow}}", "{{init|1|*||contractor_initial_sow}}"],
    ["{{sign|1|*|Signature|contractor_signature}}", "{{sign|1|*||contractor_signature}}"], // no spaces: still fails (variant NS)
    ["{{sign|1|*|contractor_signature}}", "{{sign|1|*||contractor_signature}}"], // 4-part, id in position 4 (variant ID)
  ];
  for (const [bad, fixed] of cases) {
    const v = findLabeledSignTags(`before ${bad} after`);
    assertEquals(v.length, 1, bad);
    assertEquals(v[0].tag, bad);
    assertEquals(v[0].fixedTag, fixed);
    assertStringIncludes(v[0].message, bad);
    assertStringIncludes(v[0].message, fixed);
  }
});

Deno.test("lint: labeled TEXT tags are fine (variants EA1/ET7 were readable)", () => {
  assertEquals(findLabeledSignTags("{{text|1|*|Customer Name|customer_name}} {{text|1|*|Start Date|estimated_start}}"), []);
});

Deno.test("lint: editdate is not date; a mixed document reports only the bad tags, in order", () => {
  const t = "{{editdate|1|*|Some Label|x}} {{sign|1|*||ok}} {{sign|2|*|Bad One|bad_one}} {{DATE|1|*|Bad Two|bad_two}}";
  const v = findLabeledSignTags(t);
  assertEquals(v.map((x) => x.fieldId), ["bad_one", "bad_two"]);
  assertEquals(v[1].type, "date"); // case-insensitive, normalised
  assertStringIncludes(describeLabeledSignTags(v), " | ");
});

Deno.test("lint: whitespace-only label is rejected (only the empty form was measured to work); NBSP folded", () => {
  assertEquals(findLabeledSignTags("{{sign|1|*| |id}}").length, 1);
  assertEquals(findLabeledSignTags("{{sign|1|*| |id}}").length, 1);
});

const CANONICAL = await Deno.readTextFile(new URL("./boldsign-tag-lint.ts", import.meta.url));
for (const consumer of ["create-docusign-envelope", "validate-contract-template"]) {
  Deno.test(`copy drift: ${consumer}/boldsign-tag-lint.ts is byte-identical to _shared/boldsign-tag-lint.ts`, async () => {
    const copy = await Deno.readTextFile(new URL(`../${consumer}/boldsign-tag-lint.ts`, import.meta.url));
    assert(copy === CANONICAL, `${consumer}/boldsign-tag-lint.ts has drifted from _shared — edit _shared and copy`);
  });
}
