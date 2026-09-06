// gh-1649 — ga4-report must send the SAME wire filter as
// get-business-lines-dashboard (hostName allow-list + the three bot/datacenter
// notExpressions, one andGroup). The filter is a co-located COPY (see
// ga4-filter.ts header for why not a _shared import), so these tests are the
// drift guard: both the serialised filter and the builder's source text must
// be byte-equal across the two directories, and the body ga4-report hands to
// fetch must carry it.
//
// Runs under the CI pure-unit lane (`deno test --allow-read=supabase/functions
// supabase/functions/`): the cross-directory import is fine for a TEST (deno
// resolves it locally); it is only the DEPLOY bundle that cannot.
import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import * as report from "./ga4-filter.ts";
import * as dashboard from "../get-business-lines-dashboard/ga4.ts";

function grabBuilderSource(src: string): string {
  const marker = "export function buildDimensionFilter(): unknown {";
  const start = src.indexOf(marker);
  if (start === -1) throw new Error("buildDimensionFilter not found");
  let depth = 0;
  for (let j = src.indexOf("{", start); j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error("unbalanced buildDimensionFilter");
}

Deno.test("gh-1649: ga4-report's serialised dimensionFilter is byte-equal to get-business-lines-dashboard's (#1666 andGroup)", () => {
  assertEquals(JSON.stringify(report.buildDimensionFilter()), JSON.stringify(dashboard.buildDimensionFilter()));
});

Deno.test("gh-1649: the `export function buildDimensionFilter` source text is byte-equal in both directories (co-located copy cannot drift)", async () => {
  const a = await Deno.readTextFile(new URL("./ga4-filter.ts", import.meta.url));
  const b = await Deno.readTextFile(new URL("../get-business-lines-dashboard/ga4.ts", import.meta.url));
  assertEquals(grabBuilderSource(a), grabBuilderSource(b));
});

Deno.test("gh-1649: every filter constant and the payload-facing GA4_EXCLUSIONS declaration are equal across the two copies", () => {
  assertEquals(report.GA4_PRODUCTION_HOSTS, dashboard.GA4_PRODUCTION_HOSTS);
  assertEquals(report.GA4_EXCLUDED_SOURCE_SUBSTRINGS, dashboard.GA4_EXCLUDED_SOURCE_SUBSTRINGS);
  assertEquals(report.GA4_EXCLUDED_SOURCES_EXACT, dashboard.GA4_EXCLUDED_SOURCES_EXACT);
  assertEquals(report.GA4_DATACENTER_CITIES, dashboard.GA4_DATACENTER_CITIES);
  assertEquals(report.GA4_EXCLUSIONS, dashboard.GA4_EXCLUSIONS);
});

Deno.test("gh-1649: the body ga4-report hands to fetch carries the andGroup — hostName in-list, the two sessionSource notExpressions, the city notExpression — with the caller's metrics and range", () => {
  const body = JSON.parse(JSON.stringify(report.buildGa4ReportRequestBody("84daysAgo", "today", ["sessions", "totalUsers"])));
  assertEquals(body.dateRanges, [{ startDate: "84daysAgo", endDate: "today" }]);
  assertEquals(body.metrics, [{ name: "sessions" }, { name: "totalUsers" }]);
  assertEquals(body.dimensions, undefined); // one aggregate row, no split
  const exprs = body.dimensionFilter.andGroup.expressions;
  assertEquals(exprs.length, 4);
  assertEquals(exprs[0].filter.fieldName, "hostName");
  assertEquals(exprs[0].filter.inListFilter.values, ["otterquote.com", "www.otterquote.com", "app.otterquote.com"]);
  assertEquals(exprs[1].notExpression.filter.fieldName, "sessionSource");
  assertEquals(exprs[1].notExpression.filter.stringFilter, { matchType: "CONTAINS", value: "netlify.app", caseSensitive: false });
  assertEquals(exprs[2].notExpression.filter.stringFilter, { matchType: "EXACT", value: "accounts.google.com" });
  assertEquals(exprs[3].notExpression.filter.fieldName, "city");
  assertEquals(exprs[3].notExpression.filter.inListFilter.values, report.GA4_DATACENTER_CITIES);
  assert(report.GA4_DATACENTER_CITIES.length === 11);
});
