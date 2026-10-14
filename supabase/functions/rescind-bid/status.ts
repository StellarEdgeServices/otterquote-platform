// gh-2564: the bid_status vocabulary rescind-bid reads and writes, kept in one dependency-free module so a
// test can import it (index.ts calls Deno.serve at load and cannot be imported).
//
// Production's quotes_bid_status_check (read 2026-10-13, SELECT on pg_constraint) is:
//   CHECK ((bid_status = ANY (ARRAY['active'::text, 'expired'::text, 'superseded'::text, 'cancelled'::text])))
// The value this function used to write, 'rescinded', is not in that list, so every rescind failed with 23514.
// 'cancelled' is the admitted value for a bid its contractor withdrew. It is also not "live" for the award
// paths: the gh-2626 guards (PR #2705) treat a quote as awardable only when bid_status is 'active' (or NULL).

// Statuses that permit rescission. 'active' is the live status every bid lands in (quotes.bid_status default).
// 'submitted', 'pending' and 'under_review' are not admitted by the constraint (nothing can hold them in
// production); they are kept so this change does not narrow what the function accepts.
export const RESCINDABLE_STATUSES = ["active", "submitted", "pending", "under_review"];

// The bid_status a rescinded bid is written with. Must be a value quotes_bid_status_check admits.
export const RESCINDED_BID_STATUS = "cancelled";
