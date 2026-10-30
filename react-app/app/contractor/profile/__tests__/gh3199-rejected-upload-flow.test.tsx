/**
 * gh-3199 (B1 of REVIEW: FAIL 6523204279): the full corrected-upload flow on a rejected template.
 * Renders the Contract Templates card with an in-memory supabase double, clicks "Upload a corrected
 * template", picks a PDF, and asserts the contractor_templates row LEAVES `rejected`: its PDF path
 * becomes the new file, status goes to pending_validation (via the existing #510-allowed reset) and
 * validate-contract-template is invoked for it. The double mirrors only the server's observable
 * rule that matters here (a changed pdf_storage_path => pending_validation, validation_result NULL),
 * exactly what contractor_templates_freeze_verdict + enforce_template_privileged_columns do on the
 * live database (proved in supabase/tests/gh3199_submit_template_proof.sql).
 *
 * FAIL-FIRST: on head b245930e the upload never touches contractor_templates, so the row stays
 * `rejected` and this test fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';

const db = vi.hoisted(() => ({
  tpl: { id: 't1', contractor_id: 'c1', trade: 'roofing', funding_type: 'insurance', status: 'rejected',
         pdf_storage_path: 'c1/roofing/insurance/old.pdf', validation_result: { requiredCount: 3, requiredFoundCount: 1, anchors: [] } } as Record<string, unknown>,
  contractors: { contract_templates: [] as unknown[] },
  updates: [] as Array<Record<string, unknown>>,
  invokes: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/supabase', () => {
  const contractors = db.contractors;
  const from = (table: string) => {
    let op: 'select' | 'update' = 'select';
    let payload: Record<string, unknown> = {};
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.update = (p: Record<string, unknown>) => { op = 'update'; payload = p; return q; };
    q.eq = () => q;
    const resolveMany = () => {
      if (table === 'contractor_templates' && op === 'update') {
        db.updates.push(payload);
        const t = db.tpl;
        const pathChanged = payload.pdf_storage_path !== undefined && payload.pdf_storage_path !== t.pdf_storage_path;
        if (pathChanged) { Object.assign(t, { pdf_storage_path: payload.pdf_storage_path, status: 'pending_validation', validation_result: null }); }
        return { data: [{ ...t }], error: null };
      }
      if (table === 'contractors' && op === 'update') {
        (contractors as Record<string, unknown>).contract_templates = payload.contract_templates;
        return { data: [{ id: 'c1' }], error: null };
      }
      return { data: [], error: null };
    };
    q.maybeSingle = async () => ({ data: table === 'contractor_templates' ? { ...db.tpl } : null, error: null });
    q.single = async () => (table === 'contractors' ? { data: { ...contractors }, error: null } : { data: { ...db.tpl }, error: null });
    q.then = (res: (v: unknown) => unknown) => Promise.resolve(resolveMany()).then(res);
    return q;
  };
  return {
    supabase: {
      from,
      rpc: vi.fn(),
      storage: { from: () => ({ upload: async () => ({ error: null }), createSignedUrl: async () => ({ data: { signedUrl: 'x' }, error: null }) }) },
      functions: { invoke: vi.fn(async (_n: string, opts: { body: Record<string, unknown> }) => {
        db.invokes.push(opts.body);
        return { data: { status: 'auto_validated', validation_result: { requiredCount: 3, requiredFoundCount: 3, anchors: [] } }, error: null };
      }) },
    },
  };
});

import { ContractTemplates } from '../ContractTemplates';

beforeEach(() => {
  cleanup();
  db.tpl = { id: 't1', contractor_id: 'c1', trade: 'roofing', funding_type: 'insurance', status: 'rejected',
             pdf_storage_path: 'c1/roofing/insurance/old.pdf', validation_result: { requiredCount: 3, requiredFoundCount: 1, anchors: [] } };
  db.updates = []; db.invokes = [];
  db.contractors.contract_templates = [{ trade: 'Roofing', funding_type: 'Insurance (full replacement)', file_url: 'c1/roofing/insurance/old.pdf', file_name: 'old.pdf', uploaded_at: '2026-01-01T00:00:00Z' }];
});

describe('corrected upload on a rejected template re-enters validation (gh-3199 B1)', () => {
  it('the contractor_templates row leaves rejected after the corrected upload', async () => {
    const initial = [{ trade: 'Roofing', funding_type: 'Insurance (full replacement)', file_url: 'c1/roofing/insurance/old.pdf', file_name: 'old.pdf', uploaded_at: '2026-01-01T00:00:00Z' }];
    const { container } = render(<ContractTemplates contractorId="c1" initialTemplates={initial as never} />);
    await waitFor(() => expect(screen.getByText('Upload a corrected template')).toBeTruthy());

    fireEvent.click(screen.getByText('Upload a corrected template'));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['%PDF-1.4 corrected'], 'corrected.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(db.updates.length).toBeGreaterThan(0));
    const upd = db.updates[0];
    expect(upd.status).toBe('pending_validation');
    expect(upd.validation_result).toBeNull();
    expect(String(upd.pdf_storage_path)).not.toBe('c1/roofing/insurance/old.pdf');
    expect(db.tpl.status).not.toBe('rejected');
    await waitFor(() => expect(db.invokes).toEqual([{ contractor_template_id: 't1' }]));
    // validation outcome is shown and the rejected-only action is gone
    await waitFor(() => expect(screen.queryByText('Upload a corrected template')).toBeNull());
  });

  it('a rejected row whose path did not change is left alone (no loop, no write)', async () => {
    const initial = [{ trade: 'Roofing', funding_type: 'Insurance (full replacement)', file_url: 'c1/roofing/insurance/old.pdf', file_name: 'old.pdf', uploaded_at: '2026-01-01T00:00:00Z' }];
    render(<ContractTemplates contractorId="c1" initialTemplates={initial as never} />);
    await waitFor(() => expect(screen.getByText('Upload a corrected template')).toBeTruthy());
    expect(db.updates).toHaveLength(0);
    expect(db.tpl.status).toBe('rejected');
  });

  // REVIEW: FAIL 6523537266 (B1'): wizard-written entries carry `path`, not `file_url`; merely viewing the card must not touch the row.
  it('a path-only entry on a rejected row, rendered with no click and no upload: NO update, NO validation, still rejected', async () => {
    db.contractors.contract_templates = [{ trade: 'Roofing', funding_type: 'Insurance (full replacement)', path: 'c1/roofing/insurance/old.pdf', uploaded_at: '2026-01-01T00:00:00Z' }];
    const initial = db.contractors.contract_templates;
    render(<ContractTemplates contractorId="c1" initialTemplates={initial as never} />);
    await waitFor(() => expect(screen.getByText('Upload a corrected template')).toBeTruthy());
    await new Promise((r) => setTimeout(r, 50)); // let any mount-time effect finish
    expect(db.updates).toHaveLength(0);
    expect(db.invokes).toHaveLength(0);
    expect(db.tpl.status).toBe('rejected');
    expect(db.tpl.pdf_storage_path).toBe('c1/roofing/insurance/old.pdf');
  });

  it('an entry with neither file_url nor path: no update, no validation, never the string "undefined"', async () => {
    db.contractors.contract_templates = [{ trade: 'Roofing', funding_type: 'Insurance (full replacement)', uploaded_at: '2026-01-01T00:00:00Z' }];
    render(<ContractTemplates contractorId="c1" initialTemplates={db.contractors.contract_templates as never} />);
    await waitFor(() => expect(screen.getByText('Upload a corrected template')).toBeTruthy());
    await new Promise((r) => setTimeout(r, 50));
    expect(db.updates).toHaveLength(0);
    expect(db.invokes).toHaveLength(0);
    expect(JSON.stringify(db.tpl)).not.toContain('undefined');
  });

  it('a path-only entry: the corrected upload still resets the row (upload path, new file)', async () => {
    db.contractors.contract_templates = [{ trade: 'Roofing', funding_type: 'Insurance (full replacement)', path: 'c1/roofing/insurance/old.pdf' }];
    const { container } = render(<ContractTemplates contractorId="c1" initialTemplates={db.contractors.contract_templates as never} />);
    await waitFor(() => expect(screen.getByText('Upload a corrected template')).toBeTruthy());
    fireEvent.click(screen.getByText('Upload a corrected template'));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['%PDF-1.4 x'], 'c.pdf', { type: 'application/pdf' })] } });
    await waitFor(() => expect(db.updates).toHaveLength(1));
    expect(db.updates[0].status).toBe('pending_validation');
    expect(String(db.updates[0].pdf_storage_path)).toMatch(/^c1\/roofing_insurance_full_replacement_\d+\.pdf$/);
    expect(db.tpl.status).not.toBe('rejected');
  });
});
