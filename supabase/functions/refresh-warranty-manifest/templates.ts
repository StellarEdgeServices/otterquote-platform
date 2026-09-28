// templates.ts (gh-1824 footer batch 5)
//
// Email text builder for refresh-warranty-manifest's quarterly admin
// notification, split out of index.ts so it can be unit-tested without
// importing index.ts (which calls `Deno.serve()` at module load time and
// would start listening for requests). Same convention as
// send-message-notification/templates.ts (gh-1824 footer batch 2).

import { footerPostalAddressText } from "./email-footer.ts"; // gh-1824

export interface DriftRowForEmail {
  manufacturer: string;
}

export function warrantyDriftEmailText(
  count: number,
  rows: DriftRowForEmail[],
  gafProgrammatic: boolean,
): string {
  const manufacturerBreakdown = Object.entries(
    rows.reduce((acc: Record<string, number>, r) => {
      acc[r.manufacturer] = (acc[r.manufacturer] ?? 0) + 1;
      return acc;
    }, {}),
  )
    .map(([mfr, n]) => `  • ${mfr}: ${n} item(s)`)
    .join("\n");

  return [
    `Warranty Manifest Quarterly Review`,
    ``,
    `${count} item(s) flagged for your review.`,
    ``,
    `Breakdown:`,
    manufacturerBreakdown,
    ``,
    gafProgrammatic
      ? `GAF: programmatic scrape completed.`
      : `All manufacturers: manual review required (no_source).`,
    ``,
    `Review queue: https://otterquote.com/admin-warranty-drift.html`,
    ``,
    `No changes will be made to the warranty manifest until you approve them.`,
    ``,
    `— Otter Quotes Platform`,
    ``,
    footerPostalAddressText(),
  ].join("\n");
}
