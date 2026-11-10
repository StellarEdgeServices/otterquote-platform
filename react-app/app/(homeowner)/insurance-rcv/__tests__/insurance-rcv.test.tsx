import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/hooks/use-auth-ready', () => ({ useAuthReady: vi.fn() }));
vi.mock('@/hooks/use-notification-count', () => ({
  useNotificationCount: () => ({ count: 0, loading: false, error: null }),
}));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      getSession: vi.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      signOut: vi.fn(),
    },
  },
}));
vi.mock('../../_d407/use-d407-claim', () => ({
  useD407Data: vi.fn(),
  saveClaim: vi.fn(() => Promise.resolve()),
  saveContact: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../help-materials/use-help-materials-data', () => ({
  useDesignerProducts: () => ({ products: [], loading: false, error: null }),
  useCurrentClaimId: vi.fn(),
  saveMaterialSelection: vi.fn(),
}));
vi.mock('../../dashboard/actions', () => ({ uploadClaimDocument: vi.fn(() => Promise.resolve({ ok: true })) }));

import { useAuthReady } from '@/hooks/use-auth-ready';
import { useD407Data, saveClaim, saveContact } from '../../_d407/use-d407-claim';
import { uploadClaimDocument } from '../../dashboard/actions';
import Page from '../page';

const authed = {
  user: { id: 'u1', email: 'jane@example.com' },
  role: 'homeowner',
  isAdmin: false,
  loading: false,
  settled: true,
  signOut: vi.fn(),
};

function wire(claim: Record<string, unknown>, profile: Record<string, unknown> = { full_name: 'Jane Doe', phone: '317-555-0100' }) {
  (useAuthReady as unknown as ReturnType<typeof vi.fn>).mockReturnValue(authed);
  (useD407Data as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    claim: { id: 'c1', user_id: 'u1', property_address: '1 Main St', property_city: 'Indianapolis', property_state: 'IN', property_zip: '46201', ...claim },
    profile,
    loading: false,
    error: null,
  });
}

async function pickShingle3Tab() {
  fireEvent.click(await screen.findByText('Shingles'));
  fireEvent.click(await screen.findByText('3-Tab Shingle'));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RCV page', () => {
  it('NEGATIVE CONTROL: required items missing -> Continue does not save', async () => {
    wire({ policy_type: 'rcv', has_estimate: false });
    render(<Page />);
    fireEvent.click(await screen.findByTestId('d407-continue'));
    const list = await screen.findByTestId('d407-missing');
    expect(list.textContent).toContain('Insurance estimate upload');
    expect(list.textContent).toContain('Material selection');
    expect(saveClaim).not.toHaveBeenCalled();
    expect(saveContact).not.toHaveBeenCalled();
  });

  it('missing phone blocks advance even with estimate and materials', async () => {
    wire({ policy_type: 'rcv', has_estimate: true }, { full_name: 'Jane Doe', phone: '' });
    render(<Page />);
    await pickShingle3Tab();
    fireEvent.click(screen.getByTestId('d407-continue'));
    expect((await screen.findByTestId('d407-missing')).textContent).toContain('Phone');
    expect(saveClaim).not.toHaveBeenCalled();
  });

  it('complete page saves contact + one claims write with no policy_type', async () => {
    wire({ policy_type: 'rcv', has_estimate: true });
    render(<Page />);
    await pickShingle3Tab();
    fireEvent.click(screen.getByTestId('d407-continue'));
    await waitFor(() => expect(saveClaim).toHaveBeenCalledTimes(1));
    expect(saveContact).toHaveBeenCalledWith('u1', 'Jane Doe', '317-555-0100');
    const [claimId, update] = (saveClaim as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(claimId).toBe('c1');
    expect(update.job_type).toBe('insurance_rcv');
    expect(update.has_material_selection).toBe(true);
    expect('policy_type' in update).toBe(false);
  });

  it('estimate upload uses the existing uploadClaimDocument (kind estimate) and flips to done', async () => {
    wire({ policy_type: 'rcv', has_estimate: false });
    render(<Page />);
    const input = await screen.findByTestId('d407-estimate-input');
    const file = new File(['x'], 'estimate.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByTestId('d407-estimate-done')).toBeTruthy());
    expect((uploadClaimDocument as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      kind: 'estimate',
      claimId: 'c1',
      userId: 'u1',
    });
  });

  it('stored rcv shows the Replacement Cost Value banner', async () => {
    wire({ policy_type: 'rcv' });
    render(<Page />);
    expect((await screen.findByTestId('d407-policy-banner')).textContent).toContain('Replacement Cost Value');
  });

  it.each([['idk'], [null], ['acv']])('stored policy %s: NO policy-type assertion and no overwrite', async (stored) => {
    wire({ policy_type: stored, has_estimate: true });
    const { container } = render(<Page />);
    await screen.findByTestId('d407-continue');
    expect(screen.queryByTestId('d407-policy-banner')).toBeNull();
    expect(container.textContent).not.toMatch(/Replacement Cost/i);
    await pickShingle3Tab();
    fireEvent.click(screen.getByTestId('d407-continue'));
    await waitFor(() => expect(saveClaim).toHaveBeenCalledTimes(1));
    const update = (saveClaim as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect('policy_type' in update).toBe(false);
    expect('job_type' in update).toBe(false);
  });
});

describe('RCV page: the gh-3471 / D-419 return flag survives Save (gh-3283 / gh-3285 review F2)', () => {
  let assign: ReturnType<typeof vi.fn>;
  const realLocation = window.location;
  function setSearch(search: string) {
    assign = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true, writable: true,
      value: { assign, search, origin: 'https://app.otterquote.com', href: 'https://app.otterquote.com/insurance-rcv' + search, hostname: 'app.otterquote.com', protocol: 'https:' },
    });
  }
  afterEach(() => { Object.defineProperty(window, 'location', { configurable: true, writable: true, value: realLocation }); });

  async function finish() {
    wire({ policy_type: 'rcv', has_estimate: true });
    render(<Page />);
    await pickShingle3Tab();
    fireEvent.click(screen.getByTestId('d407-continue'));
    await waitFor(() => expect(saveClaim).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    return assign.mock.calls[0][0] as string;
  }

  it('?return=measurements is carried to the dashboard that forwards it', async () => {
    setSearch('?claim_id=c1&return=measurements');
    expect(await finish()).toBe('https://otterquote.com/dashboard.html?return=measurements');
  });

  it('no token: the plain dashboard, no return param', async () => {
    setSearch('?claim_id=c1');
    expect(await finish()).toBe('https://otterquote.com/dashboard.html');
  });

  it.each(['https://evil.example/', '//evil.example', 'javascript:alert(1)', '__proto__', 'MEASUREMENTS'])(
    'NEGATIVE CONTROL: ?return=%s is not an allowlisted token, so nothing is carried and nowhere else is visited',
    async (bad) => {
      setSearch('?claim_id=c1&return=' + encodeURIComponent(bad));
      const dest = await finish();
      expect(dest).toBe('https://otterquote.com/dashboard.html');
      expect(new URL(dest).hostname).toBe('otterquote.com');
    },
  );

  it('a failed save does not navigate', async () => {
    setSearch('?claim_id=c1&return=measurements');
    (saveClaim as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    wire({ policy_type: 'rcv', has_estimate: true });
    render(<Page />);
    await pickShingle3Tab();
    fireEvent.click(screen.getByTestId('d407-continue'));
    await waitFor(() => expect(saveClaim).toHaveBeenCalledTimes(1));
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('RCV page: GA4 project_info_saved (port of project-info-rcv.html:255)', () => {
  let assign: ReturnType<typeof vi.fn>;
  let gtag: ReturnType<typeof vi.fn>;
  const realLocation = window.location;
  beforeEach(() => {
    assign = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true, writable: true,
      value: { assign, search: '?claim_id=c1', origin: 'https://app.otterquote.com', href: 'https://app.otterquote.com/insurance-rcv?claim_id=c1', hostname: 'app.otterquote.com', protocol: 'https:' },
    });
    // gtag as GA4Gate defines it once consent allows: the helper waits on event_callback, so the stub calls it like gtag.js does.
    gtag = vi.fn((...args: unknown[]) => {
      const params = args[2] as { event_callback?: () => void } | undefined;
      params?.event_callback?.();
    });
    (window as unknown as { gtag?: unknown }).gtag = gtag;
  });
  afterEach(() => {
    delete (window as unknown as { gtag?: unknown }).gtag;
    Object.defineProperty(window, 'location', { configurable: true, writable: true, value: realLocation });
  });

  async function submit(claim: Record<string, unknown>) {
    wire(claim);
    render(<Page />);
    await pickShingle3Tab();
    fireEvent.click(screen.getByTestId('d407-continue'));
    await waitFor(() => expect(saveClaim).toHaveBeenCalledTimes(1));
  }
  const savedEvents = () => gtag.mock.calls.filter((c) => c[0] === 'event' && c[1] === 'project_info_saved');

  it('a successful save fires project_info_saved once, job_type insurance_rcv (same params as project-info-rcv.html)', async () => {
    await submit({ policy_type: 'rcv', has_estimate: true });
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    const events = savedEvents();
    expect(events).toHaveLength(1);
    const { event_callback, event_timeout, ...params } = events[0][2] as Record<string, unknown>;
    expect(params).toEqual({ job_type: 'insurance_rcv' });
    expect(typeof event_callback).toBe('function');
    expect(event_timeout).toBe(1000);
    // fired after the claims write and before the redirect
    expect(gtag.mock.invocationCallOrder[0]).toBeGreaterThan((saveClaim as unknown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
    expect(gtag.mock.invocationCallOrder[0]).toBeLessThan(assign.mock.invocationCallOrder[0]);
  });

  it('a stored idk (not sure) answer still sends job_type insurance_rcv, as project-info-rcv.html does for every save', async () => {
    await submit({ policy_type: 'idk', has_estimate: true });
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    const events = savedEvents();
    expect(events).toHaveLength(1);
    const { event_callback, event_timeout, ...params } = events[0][2] as Record<string, unknown>;
    expect(params).toEqual({ job_type: 'insurance_rcv' });
    expect(typeof event_callback).toBe('function');
    expect(event_timeout).toBe(1000);
    // fired after the claims write and before the redirect
    expect(gtag.mock.invocationCallOrder[0]).toBeGreaterThan((saveClaim as unknown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
    expect(gtag.mock.invocationCallOrder[0]).toBeLessThan(assign.mock.invocationCallOrder[0]);
  });

  it('NEGATIVE CONTROL: a failed claims save fires no project_info_saved and does not navigate', async () => {
    (saveClaim as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    await submit({ policy_type: 'rcv', has_estimate: true });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(savedEvents()).toHaveLength(0);
    expect(assign).not.toHaveBeenCalled();
  });

  it('NEGATIVE CONTROL: a failed contact save fires no project_info_saved (the claims write never runs)', async () => {
    (saveContact as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    wire({ policy_type: 'rcv', has_estimate: true });
    render(<Page />);
    await pickShingle3Tab();
    fireEvent.click(screen.getByTestId('d407-continue'));
    await waitFor(() => expect(saveContact).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(saveClaim).not.toHaveBeenCalled();
    expect(savedEvents()).toHaveLength(0);
    expect(assign).not.toHaveBeenCalled();
  });

  it('NEGATIVE CONTROL: a blocked Continue (required items missing) fires nothing', async () => {
    wire({ policy_type: 'rcv', has_estimate: true });
    render(<Page />);
    fireEvent.click(await screen.findByTestId('d407-continue'));
    await screen.findByTestId('d407-missing');
    expect(saveClaim).not.toHaveBeenCalled();
    expect(gtag).not.toHaveBeenCalled();
  });

  it('no gtag (consent gate did not load GA4): the save still navigates and nothing throws', async () => {
    delete (window as unknown as { gtag?: unknown }).gtag;
    await submit({ policy_type: 'rcv', has_estimate: true });
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(gtag).not.toHaveBeenCalled();
  });
});
