/**
 * gh-1991 + gh-1993 (CEO RUN 48).
 *
 * gh-1993 (CEO RUN 48) — Step 1's single "Property Address" box replaced
 * with four fields: Street / City / State (select) / ZIP. Covers the new
 * autocomplete wiring, per-field validation messages, and that a fully
 * valid Step 1 still advances to Step 2 — negative controls are the
 * individual missing/invalid-field cases, each asserted to block advance
 * with today's SPECIFIC error, not the old generic "enter your address".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@/hooks/use-auth-ready', () => ({ useAuthReady: vi.fn() }));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      signUp: vi.fn(() => Promise.resolve({ data: {}, error: null })),
      signInWithOAuth: vi.fn(() => Promise.resolve({ data: {}, error: null })),
    },
    from: vi.fn(() => ({
      insert: vi.fn(() => ({ then: (cb: (r: unknown) => void) => cb({ error: null }) })),
    })),
  },
}));

import { useAuthReady } from '@/hooks/use-auth-ready';
import GetStartedPage from '../page';

type AuthVal = ReturnType<typeof vi.fn>;
const mockAuth = (v: unknown) => (useAuthReady as unknown as AuthVal).mockReturnValue(v);

function fillStreetCityState(street: string, city: string, state: string) {
  if (street !== undefined) fireEvent.change(screen.getByLabelText('Street Address'), { target: { value: street } });
  if (city !== undefined) fireEvent.change(screen.getByLabelText('City'), { target: { value: city } });
  if (state !== undefined) fireEvent.change(screen.getByLabelText('State'), { target: { value: state } });
}

describe('GetStartedPage — gh-1993 Street/City/State/ZIP', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth({ user: null, role: null, loading: false });
  });

  it('renders four separate fields with the WHATWG autocomplete tokens, not one address box', () => {
    render(<GetStartedPage />);
    expect(screen.queryByLabelText('Property Address')).not.toBeInTheDocument();

    expect(screen.getByLabelText('Street Address')).toHaveAttribute('autocomplete', 'address-line1');
    expect(screen.getByLabelText('City')).toHaveAttribute('autocomplete', 'address-level2');
    expect(screen.getByLabelText('State')).toHaveAttribute('autocomplete', 'address-level1');
    expect(screen.getByLabelText('ZIP Code')).toHaveAttribute('autocomplete', 'postal-code');
  });

  it('blocks advance and names the missing field — street first', () => {
    render(<GetStartedPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Please enter your street address.');
  });

  it('blocks advance and names the missing field — city, once street is filled', () => {
    render(<GetStartedPage />);
    fillStreetCityState('123 Main St', '', '');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Please enter your city.');
  });

  it('blocks advance and names the missing field — state, once street+city are filled', () => {
    render(<GetStartedPage />);
    fillStreetCityState('123 Main St', 'Anytown', '');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Please select your state.');
  });

  it('rejects a ZIP that is not exactly 5 digits (negative control: 4 digits)', () => {
    render(<GetStartedPage />);
    fillStreetCityState('123 Main St', 'Anytown', 'IN');
    fireEvent.change(screen.getByLabelText('ZIP Code'), { target: { value: '4620' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Please enter a valid 5-digit ZIP code.');
  });

  it('strips non-digit characters typed into ZIP and caps at 5 digits', () => {
    render(<GetStartedPage />);
    const zipInput = screen.getByLabelText('ZIP Code') as HTMLInputElement;
    fireEvent.change(zipInput, { target: { value: '46a20b1999' } });
    expect(zipInput.value).toBe('46201');
  });

  it('advances to Step 2 once street/city/state/ZIP are all valid (positive)', () => {
    render(<GetStartedPage />);
    fillStreetCityState('123 Main St', 'Anytown', 'IN');
    fireEvent.change(screen.getByLabelText('ZIP Code'), { target: { value: '46201' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.getByRole('heading', { name: 'Create Your Account' })).toBeInTheDocument();
  });
});

describe('GetStartedPage — gh-1991 "what do you need help with?" options', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth({ user: null, role: null, loading: false });
  });

  it('offers exactly Roof / Siding / Gutters / Windows / Other — no Water Damage, no Doors', () => {
    render(<GetStartedPage />);
    const chips = screen.getAllByRole('button').filter(btn =>
      ['Roof', 'Siding', 'Gutters', 'Windows', 'Other'].includes(btn.textContent || ''));
    expect(chips.map(c => c.textContent)).toEqual(['Roof', 'Siding', 'Gutters', 'Windows', 'Other']);

    // Negative control: the two removed options from before this change.
    expect(screen.queryByText('Water Damage')).not.toBeInTheDocument();
    expect(screen.queryByText('Windows/Doors')).not.toBeInTheDocument();
  });
});
