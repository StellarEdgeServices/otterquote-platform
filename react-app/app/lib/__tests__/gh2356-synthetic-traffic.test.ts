/**
 * gh-2356 -- the React app's dispatch gate. A QA walk (qa=1, oq_internal=1, a test fbclid/utm, or the oq_internal cookie) must not reach
 * window.gtag or window.fbq through track() / fbqTrack() / fireSignUpAndWait(); a clean visitor is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isInternalTraffic, isSyntheticTrafficParams } from '../internal-traffic';
import { track, fbqTrack, fireSignUpAndWait } from '../track';

function setLocation(search: string) {
  window.history.replaceState(null, '', '/get-started' + search);
}
function clearCookie() {
  document.cookie = 'oq_internal=; Max-Age=0; path=/';
}

describe('isSyntheticTrafficParams', () => {
  it.each([
    ['?qa=1'],
    ['?fbclid=TESTFBCLID123'],
    ['?fbclid=ceo75walk1790609196'],
    ['?fbclid=CEO71TEST1790446212'],
    ['?fbclid=ceo67walkbduod'],
    ['?fbclid=sloane66walkm3'],
    ['?fbclid=cro37probe'],
    ['?fbclid=cro38fbwalkclean01'],
    ['?utm_source=ceo53'],
    ['?utm_source=ceo64probe'],
    ['?utm_source=rw-test'],
    ['?utm_source=rwf35test'],
    ['?utm_source=cto33_probe'],
  ])('%s is synthetic', (q) => {
    expect(isSyntheticTrafficParams(new URLSearchParams(q))).toBe(true);
  });
  it.each([[''], ['?fbclid=IwAR3realClickId'], ['?utm_campaign=testimonials-spring&utm_source=qatar-roofing'], ['?qa=0'],
    ['?fbclid=IwAR_real_looking&utm_campaign=Test_Video_A'],
    ['?gclid=Cj0KCQreal&utm_term=test%20for%20hail%20damage'],
    ['?fbclid=IwZXh0bgNhZW0CMTAAAR3kqWm9x_ceo75walk_Jt2vXbP7Q8sHnLrE0aYcUfD1oGiTz4w'],
    ['?utm_source=benefits-guide&utm_medium=croatia&utm_campaign=QA-Roofing-Leads']])(
    '%s is NOT synthetic',
    (q) => {
      expect(isSyntheticTrafficParams(new URLSearchParams(q))).toBe(false);
    },
  );
});

describe('dispatch gate', () => {
  let gtag: ReturnType<typeof vi.fn>;
  let fbq: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    clearCookie();
    gtag = vi.fn();
    fbq = vi.fn();
    (window as any).gtag = gtag;
    (window as any).fbq = fbq;
  });
  afterEach(() => {
    clearCookie();
    setLocation('');
    delete (window as any).gtag;
    delete (window as any).fbq;
  });

  it('CONTROL: a clean walk still reaches gtag and fbq', () => {
    setLocation('?fbclid=IwAR3realClickId&utm_source=facebook');
    expect(isInternalTraffic()).toBe(false);
    track('sign_up' as any, { method: 'google' } as any);
    fbqTrack('Lead');
    expect(gtag).toHaveBeenCalledTimes(1);
    expect(fbq).toHaveBeenCalledTimes(1);
  });

  it.each([['?qa=1'], ['?fbclid=TESTFBCLID123'], ['?fbclid=ceo75walk1790609196'], ['?oq_internal=1']])(
    'QA walk %s emits ZERO gtag and ZERO fbq calls',
    async (q) => {
      setLocation(q);
      track('sign_up' as any, { method: 'google' } as any);
      fbqTrack('Lead');
      expect(await fireSignUpAndWait({ method: 'google' } as any, 20)).toBe(false);
      expect(gtag).not.toHaveBeenCalled();
      expect(fbq).not.toHaveBeenCalled();
    },
  );

  it('the walk is remembered on the next page (cookie only, no params)', () => {
    setLocation('?fbclid=TESTFBCLID123');
    expect(isInternalTraffic()).toBe(true);
    setLocation('');
    track('sign_up' as any, { method: 'google' } as any);
    fbqTrack('Lead');
    expect(gtag).not.toHaveBeenCalled();
    expect(fbq).not.toHaveBeenCalled();
  });
});
