/**
 * gh-3858 (review fix 3): createHoverPaymentIntent passes the gh-3356 refusal code through instead of swallowing it into
 * `placeholder: true`, so the page can say why. Any other failure still returns the placeholder, and success is unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: vi.fn() }, from: vi.fn(), auth: { getSession: vi.fn() } } }));

import { supabase } from '@/lib/supabase';
import { createHoverPaymentIntent } from '../services';

const invoke = () => supabase.functions.invoke as unknown as ReturnType<typeof vi.fn>;
const params = { claim_id: 'c1', amount: 2263 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('createHoverPaymentIntent refusal codes (gh-3356)', () => {
  it.each(['MEASUREMENT_ALREADY_PAID', 'MEASUREMENT_PAYMENT_CHECK_UNAVAILABLE', 'MEASUREMENT_PAYMENT_CANNOT_START'])(
    'passes %s through',
    async (code) => {
      invoke().mockResolvedValue({ data: null, error: { context: { json: async () => ({ code }) } } });
      expect(await createHoverPaymentIntent(params)).toEqual({ client_secret: null, refused: true, code });
    },
  );

  it('an unknown code, a non-JSON body or no context still returns the placeholder', async () => {
    invoke().mockResolvedValueOnce({ data: null, error: { context: { json: async () => ({ code: 'SOMETHING_ELSE' }) } } });
    expect(await createHoverPaymentIntent(params)).toEqual({ client_secret: null, placeholder: true });
    invoke().mockResolvedValueOnce({ data: null, error: { context: { json: async () => { throw new Error('not json'); } } } });
    expect(await createHoverPaymentIntent(params)).toEqual({ client_secret: null, placeholder: true });
    invoke().mockResolvedValueOnce({ data: null, error: new Error('boom') });
    expect(await createHoverPaymentIntent(params)).toEqual({ client_secret: null, placeholder: true });
  });

  it('success returns the client secret unchanged', async () => {
    invoke().mockResolvedValue({ data: { client_secret: 'pi_1_secret_x' }, error: null });
    expect(await createHoverPaymentIntent(params)).toEqual({ client_secret: 'pi_1_secret_x' });
  });
});
