/**
 * gh-3266 — "Create Your Account" layout tidy (design only).
 *
 * Pins the hard rules from the issue:
 *  1. No wording changes: the visible text of step 1 and of step 2 (prefilled
 *     "Signing up as" visitor and direct visitor) is identical to origin/main
 *     at 4ee68852 (fixture: gh3266-visible-text.main.json). Text is compared as
 *     sorted multisets (text nodes + per-element text of every p/label/button/
 *     heading/link) because the redesign moves "Already have an account?" and
 *     "Are you a contractor?" below Google; order rules that matter legally are
 *     asserted separately below. A negative control proves the comparison bites.
 *  2. SMS consent checkbox: optional, unchecked by default, separate, and
 *     before the Create My Account button in DOM order.
 *  3. The Terms/Privacy agreement line stays adjacent to the submit action.
 *
 * Regenerate the fixture (only from main, never from a branch) with
 *   GH3266_DUMP=1 npx vitest run app/get-started/__tests__/gh3266-layout-text-parity.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import fs from 'fs';
import path from 'path';

vi.mock('@/hooks/use-auth-ready', () => ({
  useAuthReady: () => ({ user: null, role: null, loading: false }),
}));

const rpcMock = vi.fn();
vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    auth: {
      signUp: vi.fn(() => Promise.resolve({ data: { user: null, session: null }, error: null })),
      signInWithOAuth: vi.fn(() => Promise.resolve({ error: null })),
    },
    from: vi.fn(() => ({ insert: vi.fn(() => Promise.resolve({ error: null })) })),
  },
}));

vi.mock('@/lib/cookie-storage', () => ({
  readReferralIds: () => ({}),
  writeReferralIds: vi.fn(),
}));

import GetStartedPage from '../page';

const FIXTURE = path.join(__dirname, 'fixtures', 'gh3266-visible-text.main.json');
const LEAD = 'cccccccc-1111-2222-3333-444444444444';

type Snapshot = { nodes: string[]; blocks: string[] };

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Everything a visitor can read: text nodes, placeholders, and per-element text. */
function visibleText(root: HTMLElement): Snapshot {
  const nodes: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement;
    if (!parent || parent.closest('style, script')) continue;
    const t = norm(n.textContent || '');
    if (t) nodes.push(t);
  }
  root.querySelectorAll<HTMLInputElement>('[placeholder]').forEach((el) => {
    nodes.push(`placeholder:${el.getAttribute('placeholder')}`);
  });
  const blocks: string[] = [];
  root
    .querySelectorAll('p, label, button, h1, h2, h3, h4, a, option, [data-testid="signing-up-as"]')
    .forEach((el) => {
      const t = norm(el.textContent || '');
      if (t) blocks.push(`${el.tagName.toLowerCase()}:${t}`);
    });
  return { nodes: [...nodes].sort(), blocks: [...blocks].sort() };
}

function toStep2() {
  fireEvent.change(screen.getByLabelText('Street Address'), { target: { value: '1 Otter Way' } });
  fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Austin' } });
  fireEvent.change(screen.getByLabelText('State'), { target: { value: 'TX' } });
  fireEvent.change(screen.getByLabelText('ZIP Code'), { target: { value: '78701' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
}

async function renderStep(scenario: 'step1' | 'prefilled' | 'direct') {
  if (scenario === 'prefilled') {
    rpcMock.mockResolvedValueOnce({
      data: [{ name: 'Jane Homeowner', email: 'jane.homeowner+storm2026@example.com', phone: '3175551234' }],
      error: null,
    });
    (window as unknown as { __oqRouterLeadId?: string }).__oqRouterLeadId = LEAD;
  }
  const { container } = render(<GetStartedPage />);
  if (scenario === 'prefilled') {
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
  }
  if (scenario !== 'step1') {
    toStep2();
    await screen.findByRole('heading', { name: 'Create Your Account', exact: true });
    if (scenario === 'prefilled') await screen.findByTestId('signing-up-as');
  }
  return container as HTMLElement;
}

beforeEach(() => {
  rpcMock.mockReset();
  localStorage.clear();
  sessionStorage.clear();
  (window as unknown as { __oqRouterLeadId?: string }).__oqRouterLeadId = undefined;
});
afterEach(() => cleanup());

const SCENARIOS = ['step1', 'prefilled', 'direct'] as const;

if (process.env.GH3266_DUMP) {
  it('dumps the main-branch visible-text fixture', async () => {
    const out: Record<string, Snapshot> = {};
    for (const s of SCENARIOS) {
      out[s] = visibleText(await renderStep(s));
      cleanup();
      rpcMock.mockReset();
      (window as unknown as { __oqRouterLeadId?: string }).__oqRouterLeadId = undefined;
    }
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, JSON.stringify(out, null, 2) + '\n');
  });
} else {
  const main = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Record<string, Snapshot>;

  describe('gh-3266 visible text is byte-identical to main', () => {
    for (const s of SCENARIOS) {
      it(`${s}: same text nodes and same per-element text as main`, async () => {
        const now = visibleText(await renderStep(s));
        expect(now.nodes).toEqual(main[s].nodes);
        expect(now.blocks).toEqual(main[s].blocks);
      });
    }

    it('negative control: a one-character wording change is caught', async () => {
      const root = await renderStep('prefilled');
      const legal = screen.getByText(/By creating an account, you agree to our/);
      legal.firstChild!.textContent = 'By creating an account, you agree to the ';
      const now = visibleText(root);
      expect(now.nodes).not.toEqual(main.prefilled.nodes);
      expect(now.blocks).not.toEqual(main.prefilled.blocks);
    });

    it('negative control: a dropped string is caught', async () => {
      const root = await renderStep('direct');
      screen.getByText(/Are you a contractor\?/).remove();
      expect(visibleText(root).blocks).not.toEqual(main.direct.blocks);
    });
  });

  describe('gh-3266 consent and legal placement', () => {
    for (const s of ['prefilled', 'direct'] as const) {
      it(`${s}: SMS consent is optional, unchecked by default, separate, and before Create My Account`, async () => {
        await renderStep(s);
        const box = document.getElementById('sms-consent') as HTMLInputElement;
        expect(box).toBeInTheDocument();
        expect(box.type).toBe('checkbox');
        expect(box.checked).toBe(false);
        expect(box.required).toBe(false);
        const submit = screen.getByRole('button', { name: 'Create My Account' });
        // Separate from account creation: the checkbox is not inside the button.
        expect(submit.contains(box)).toBe(false);
        expect(box.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        // Google is also after the consent box (no path skips past it visually).
        const google = screen.getByRole('button', { name: /Continue with Google/ });
        expect(box.compareDocumentPosition(google) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      });

      it(`${s}: the Terms/Privacy line is the element right after the submit button`, async () => {
        await renderStep(s);
        const submit = screen.getByRole('button', { name: 'Create My Account' });
        const next = submit.nextElementSibling as HTMLElement;
        expect(next.tagName).toBe('P');
        expect(norm(next.textContent || '')).toBe(
          'By creating an account, you agree to our Terms of Service and Privacy Policy.',
        );
      });
    }
  });
}
