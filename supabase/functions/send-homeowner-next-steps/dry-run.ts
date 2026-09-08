// gh-1570 / gh-1580 — DRY-RUN FIXTURE MODE, extracted here so it can be tested
// without importing index.ts (importing it calls serve() and binds a port —
// the same reason email-content.ts, select-stage.ts and optout-filter.ts were
// extracted).
//
// WHY THIS EXISTS
// ---------------
// #1580's closing artifact, and #1570's condition 2 in its strong reading, is
// "a homeowner actually nudged" — an `activity_log` row proving the pipeline
// runs end to end. It has never been produced, and #1570's own measurement
// says why: the cron's candidate predicate matches ZERO rows.
//
//   select count(*) from claims where is_test = false
//     and status='documents_needed' and ready_for_bids=false
//     and has_measurements=false;                              -> 0
//   select count(*) from activity_log
//     where event_type='next_steps_nudge_sent';                -> 0
//
// (Both re-measured on prod 2026-09-08: still 0 and 0.) The instrument is
// live, cron-active every 30 minutes, and pointed at an empty set.
//
// The step the thread has been parked on for five days is "seed a fixture" —
// which is a production database write, and, because the sender filters
// `is_test = false`, a fixture that the cron would actually EMAIL. That is
// why nobody has done it: the only claims a real-flagged fixture can be built
// from belong to real people. `is_test = true` claims that match the rest of
// the predicate DO exist (3 on prod, 2026-09-08), and this mode reaches them
// without writing anything and without sending anything.
//
// WHAT DRY-RUN DOES
// -----------------
//   * scans `is_test = TRUE` claims — the test population, NEVER a widening
//     of the real one (see candidateIsTestFlag: the two modes are disjoint,
//     which is the property its test asserts);
//   * runs every real filter, in the real order: eligible status, opt-out,
//     hover order, real-activity-since-created, and selectStage;
//   * renders the real email through buildEmailContent, including signing a
//     real opt-out token, so a broken footer or a throwing renderer still
//     fails here;
//   * sends NOTHING and writes NOTHING. No Mailgun call, no `activity_log`
//     insert — so it cannot manufacture the very `next_steps_nudge_sent` row
//     the closing artifact is supposed to prove, which would be evidence
//     laundering rather than evidence.
//
// It is therefore not a substitute for the real send. It is the thing that
// can be run TODAY, by an authorized caller, to show which claim the pipeline
// selects, which stage it picks, who it would go to and exactly what it would
// say — and to catch a defect in any of that before a real homeowner is the
// one who finds it.

/** Literal `true` only. A string "true", 1, or a truthy object is NOT a
 * dry run: this flag changes which population is scanned, so it is read
 * strictly rather than coerced. */
export function parseDryRun(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  return (body as Record<string, unknown>).dry_run === true;
}

/** The `is_test` value the candidate scan filters on.
 *
 * dry run  -> true  (test fixtures only)
 * normal   -> false (real homeowners only, gh-1028 suppression)
 *
 * The two are disjoint by construction: there is no mode in which this
 * function returns something that scans BOTH, so a dry run can never touch a
 * real homeowner's claim and the production path can never pick up a fixture. */
export function candidateIsTestFlag(dryRun: boolean): boolean {
  return dryRun === true;
}

/** One claim the pipeline WOULD have emailed, had this not been a dry run. */
export interface WouldSend {
  claim_id: string;
  user_id: string;
  stage: string;
  to: string;
  subject: string;
  /** First line of the rendered text body — enough to see the copy rendered,
   * short enough not to paste a whole email into an issue comment. */
  text_first_line: string;
  /** True when the rendered body carries the D-320 opt-out line. A dry run
   * that reports `false` here is a CAN-SPAM defect caught before a send. */
  has_optout_link: boolean;
}
