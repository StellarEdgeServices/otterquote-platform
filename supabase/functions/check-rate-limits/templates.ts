// templates.ts (gh-1824 footer batch 3)
//
// Email text builder for check-rate-limits' internal usage-threshold alert,
// split out of index.ts so it can be unit-tested without importing
// index.ts (which calls `serve()` at module load time and would start
// listening for requests). Same convention as
// send-message-notification/templates.ts (gh-1824 footer batch 2).

import { footerPostalAddressText } from "./email-footer.ts"; // gh-1824

export function rateLimitAlertText(
  functionName: string,
  count: number,
  limit: number,
  usagePercent: number,
): string {
  return `
Function: ${functionName}
Current Usage: ${count} calls
Monthly Limit: ${limit} calls
Usage: ${Math.round(usagePercent)}%

Recommendation: Review usage patterns and consider optimization or plan for increased capacity.

This is an automated alert from OtterQuote monitoring.

${footerPostalAddressText()}
            `.trim();
}
