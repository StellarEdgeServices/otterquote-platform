/**
 * Auth helpers for OtterQuote E2E tests.
 *
 * Magic link injection strategy: rather than waiting for a real email,
 * we call the Supabase Admin API to generate a magic link URL and navigate
 * directly to it in Playwright. No email inbox required.
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.test.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = resolve(__dirname, '..', '.test-state.json');

/** Creates a Supabase client with service-role privileges. */
export function createAdminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.test'
    );
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Generates a magic link URL for the given email via the Supabase Admin API.
 * Playwright navigates to this URL directly — no email delivery required.
 *
 * @param email      - The test account email address.
 * @param redirectTo - Where Supabase should redirect after verifying the token.
 *                     Must be listed in Supabase Auth → URL Configuration →
 *                     Additional Redirect URLs (see README Prerequisites).
 * @returns The full magic link URL (https://[project].supabase.co/auth/v1/verify?...)
 */
export async function generateMagicLink(
  email: string,
  redirectTo: string
): Promise<string> {
  const supabase = createAdminClient();

  const { data, error } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email,
    options: { redirectTo },
  });

  if (error) {
    throw new Error(
      `generateMagicLink failed for ${email}: ${error.message}`
    );
  }
  const link = data?.properties?.action_link;
  if (!link) {
    throw new Error(
      `Supabase admin API returned no action_link for ${email}. ` +
        'Check that the user exists and is confirmed.'
    );
  }
  return link;
}

/** Test state written by seed.mjs and read by specs. */
export interface TestState {
  homeownerUserId: string;
  homeownerEmail: string;
  contractorUserId: string;
  contractorId: string;
  contractorEmail: string;
  testClaimId: string;
  testRetailClaimId: string;
  baseUrl: string;
  runId: string;
  seededAt: string;
}

/** Read the .test-state.json file written by seed.mjs. */
export function getTestState(): TestState {
  if (!existsSync(STATE_FILE)) {
    throw new Error(
      '.test-state.json not found. Run `npm run seed` before running tests.'
    );
  }
  return JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as TestState;
}

/** Write (or overwrite) the .test-state.json file. Called by seed.mjs. */
export function writeTestState(state: TestState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}
