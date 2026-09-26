/**
 * gh-2046 S2 — wiring test. The scrub logic itself is unit-tested in
 * sentry-scrub.test.ts; this file instead proves that Sentry.init's
 * `beforeSend`, `beforeSendTransaction`, `beforeBreadcrumb`, and
 * `replayIntegration`'s `beforeAddRecordingEvent` are actually WIRED to
 * that logic — i.e. that none of the four hooks has been (or can silently
 * become) a pass-through/identity function.
 *
 * Negative control (see report cto38-b2046r-<stamp>.md for the exact
 * commands and output): each hook in
 * app/components/SentryInitializer.tsx was, in turn, temporarily replaced
 * with an identity function (`(x) => x` / `(event) => event`) and this
 * file's corresponding test was re-run and confirmed to FAIL before the
 * change was reverted. That was done by hand against the real source file
 * (there is no supported way to "neuter" a hook from outside
 * SentryInitializer.tsx), so it is not re-executed automatically here —
 * but it is what makes the assertions below more than a description of
 * the code that happens to exist today.
 */
import { describe, it, expect, vi } from 'vitest';
import * as Sentry from '@sentry/nextjs';
import { buildSentryInitOptions } from '../../components/SentryInitializer';

const LEAD_ID = '8f14e45f-ceea-467e-b5a4-2e2c8d1b3f0a';
const LEAD_URL = `https://app.otterquote.com/get-started?lead=${LEAD_ID}`;

function assertRedacted(label: string, out: unknown): void {
  const serialized = JSON.stringify(out);
  expect(serialized, `${label}: output must not contain the raw lead id`).not.toContain(LEAD_ID);
  expect(
    serialized,
    `${label}: output must contain the redaction token — proves the hook actually ran the scrub, not a pass-through`,
  ).toContain('[redacted]');
}

describe('Sentry hook wiring (gh-2046 S2)', () => {
  const options = buildSentryInitOptions();

  it('beforeSend redacts the lead id (not a pass-through)', () => {
    expect(options.beforeSend).toBeTypeOf('function');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = options.beforeSend!({ request: { url: LEAD_URL }, tags: { origin: LEAD_URL } } as any, {} as any);
    assertRedacted('beforeSend', out);
  });

  it('beforeSendTransaction redacts the lead id (not a pass-through)', () => {
    expect(options.beforeSendTransaction).toBeTypeOf('function');
    const out = options.beforeSendTransaction!(
      {
        transaction: '/get-started',
        request: { url: LEAD_URL },
        spans: [{ description: `browser.loadEvent for ${LEAD_URL}` }],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      {} as any,
    );
    assertRedacted('beforeSendTransaction', out);
  });

  it('beforeBreadcrumb redacts the lead id (not a pass-through)', () => {
    expect(options.beforeBreadcrumb).toBeTypeOf('function');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = options.beforeBreadcrumb!({ category: 'xhr', data: { url: LEAD_URL } } as any, {} as any);
    assertRedacted('beforeBreadcrumb', out);
  });

  it('replayIntegration is wired with a beforeAddRecordingEvent that redacts the lead id (not a pass-through)', () => {
    // Sentry.replayIntegration is mocked in app/test/setup.ts (it returns
    // `{}` so init doesn't pull in the real SDK), but the mock still
    // records the real options object SentryInitializer built it with —
    // pull beforeAddRecordingEvent off that call and invoke it directly.
    const calls = vi.mocked(Sentry.replayIntegration).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const replayOptions = calls[calls.length - 1][0] as any;
    expect(replayOptions.beforeAddRecordingEvent).toBeTypeOf('function');

    const fixture = {
      type: 5,
      timestamp: Date.now(),
      data: { tag: 'performanceSpan', payload: { name: LEAD_URL, url: LEAD_URL } },
    };
    const out = replayOptions.beforeAddRecordingEvent(fixture);
    expect(out, 'beforeAddRecordingEvent must never drop the recording event').not.toBeNull();
    expect(out, 'beforeAddRecordingEvent must never drop the recording event').not.toBeUndefined();
    assertRedacted('beforeAddRecordingEvent', out);
  });

  it('beforeAddRecordingEvent never drops the event even if redaction throws (gh-2046 M1)', () => {
    const calls = vi.mocked(Sentry.replayIntegration).mock.calls;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const replayOptions = calls[calls.length - 1][0] as any;

    // A hostile value whose enumeration throws — simulates redactLeadDeep
    // hitting something it cannot safely walk.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hostile: any = {};
    Object.defineProperty(hostile, 'poison', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });

    const out = replayOptions.beforeAddRecordingEvent(hostile);
    expect(out, 'a thrown error must not drop the recording').not.toBeNull();
    expect(out, 'a thrown error must not drop the recording').not.toBeUndefined();
  });
});
