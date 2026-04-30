/**
 * D-199 Contract Template Validation — contractor-profile.html integration
 *
 * Adds anchor-validation status to each of the 8 template slots.
 * Pairs the legacy contractors.contract_templates JSONB with the new
 * contractor_templates table (D-199 v63 migration).
 *
 * Public API:
 *   - window.D199.attachValidationStatus(cellElement, contractorId, trade, fundingType, storagePath)
 *   - window.D199.validateNewlyUploadedTemplate(contractorId, trade, fundingType, storagePath)
 *   - window.D199.requestAdminReviewForTemplate(templateId)
 *
 * Authoritative manifest: data/contract-anchor-manifest.json (v2)
 * ClickUp: 86e15abmj
 */
(function () {
  'use strict';

  // Slot keys are stored title-cased ("Roofing", "Insurance") in JSONB
  // but the contractor_templates table uses lowercase. Normalize both ways.
  function tradeKey(t)        { return String(t || '').toLowerCase(); }
  function fundingKey(f)      { return String(f || '').toLowerCase(); }

  const STATUS_LABELS = {
    pending_validation:         { cls: 'val-pending',   label: 'Pending validation', icon: '⏳' },
    auto_validated:             { cls: 'val-ok',        label: 'Auto-validated',     icon: '✓' },
    manual_mapping_pending:     { cls: 'val-needs',     label: 'Needs your action',  icon: '⚠️' },
    manual_validated:           { cls: 'val-ok',        label: 'Manually validated', icon: '✓' },
    submitted_for_admin_review: { cls: 'val-review',    label: 'In admin review',    icon: '👤' },
    admin_validated:            { cls: 'val-ok',        label: 'Admin-approved',     icon: '✓' },
    rejected:                   { cls: 'val-rejected',  label: 'Rejected — re-upload', icon: '✗' },
  };

  function ensureStylesInjected() {
    if (document.getElementById('d199-validation-styles')) return;
    const style = document.createElement('style');
    style.id = 'd199-validation-styles';
    style.textContent = `
      .val-status-row { margin-top: 12px; padding: 10px 12px; border-radius: 6px; font-size: 0.85rem; }
      .val-status-row .val-icon { font-weight: 700; margin-right: 6px; }
      .val-status-row.val-pending  { background: #FEF3C7; color: #92400E; }
      .val-status-row.val-ok       { background: #D1FAE5; color: #065F46; }
      .val-status-row.val-needs    { background: #FEE2E2; color: #991B1B; }
      .val-status-row.val-review   { background: #DBEAFE; color: #1E40AF; }
      .val-status-row.val-rejected { background: #FCE7F3; color: #9F1239; }
      .val-detail-toggle { background: none; border: none; color: inherit; font-weight: 600; cursor: pointer; text-decoration: underline; padding: 0; font-size: 0.85rem; }
      .val-anchors { margin-top: 8px; padding: 8px 10px; background: rgba(255,255,255,0.6); border-radius: 4px; font-size: 0.78rem; display: none; }
      .val-anchors.open { display: block; }
      .val-anchor { padding: 3px 6px; border-radius: 3px; display: inline-block; margin: 2px 3px 2px 0; font-family: ui-monospace, monospace; font-size: 0.72rem; }
      .val-anchor.found { background: #D1FAE5; color: #065F46; }
      .val-anchor.missing { background: #FEE2E2; color: #991B1B; }
      .val-actions { margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap; }
      .val-action-btn { padding: 6px 12px; border-radius: 4px; border: none; font-size: 0.82rem; font-weight: 600; cursor: pointer; }
      .val-action-btn.primary { background: #0D1B2E; color: white; }
      .val-action-btn.primary:disabled { background: #94A3B8; cursor: not-allowed; }
      .val-action-btn.secondary { background: #E07B00; color: white; }
      .val-action-btn.secondary:hover:not(:disabled) { background: #C26B00; }
    `;
    document.head.appendChild(style);
  }

  // Find existing contractor_templates row for this slot
  async function findValidationRow(contractorId, trade, fundingType) {
    if (typeof sb === 'undefined' || !sb) return null;
    try {
      const { data, error } = await sb
        .from('contractor_templates')
        .select('*')
        .eq('contractor_id', contractorId)
        .eq('trade', tradeKey(trade))
        .eq('funding_type', fundingKey(fundingType))
        .maybeSingle();
      if (error) {
        console.warn('[D-199] findValidationRow error:', error);
        return null;
      }
      return data;
    } catch (e) {
      console.warn('[D-199] findValidationRow threw:', e);
      return null;
    }
  }

  // Insert (or update) a contractor_templates row tied to the legacy upload
  async function upsertValidationRow(contractorId, trade, fundingType, storagePath) {
    if (typeof sb === 'undefined' || !sb) return null;
    const payload = {
      contractor_id: contractorId,
      trade: tradeKey(trade),
      funding_type: fundingKey(fundingType),
      pdf_storage_path: storagePath,
      status: 'pending_validation',
      validation_result: null,
      manual_overrides: null,
    };
    try {
      const { data, error } = await sb
        .from('contractor_templates')
        .upsert(payload, { onConflict: 'contractor_id,trade,funding_type' })
        .select('*')
        .single();
      if (error) {
        console.error('[D-199] upsertValidationRow error:', error);
        return null;
      }
      return data;
    } catch (e) {
      console.error('[D-199] upsertValidationRow threw:', e);
      return null;
    }
  }

  // Call validate-contract-template Edge Function
  async function callValidateEdgeFunction(contractorTemplateId, manualOverrides) {
    if (typeof CONFIG === 'undefined' || !CONFIG.SUPABASE_URL) return { error: 'CONFIG missing' };
    const url = CONFIG.SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/validate-contract-template';
    const sessionResult = await sb.auth.getSession();
    const token = sessionResult?.data?.session?.access_token || CONFIG.SUPABASE_ANON;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
          'apikey': CONFIG.SUPABASE_ANON,
        },
        body: JSON.stringify({
          contractor_template_id: contractorTemplateId,
          manualOverrides: manualOverrides || undefined,
        }),
      });
      const text = await resp.text();
      let body;
      try { body = JSON.parse(text); } catch (_) { body = { rawText: text }; }
      if (!resp.ok) return { error: body?.error || ('HTTP ' + resp.status), details: body };
      return body;
    } catch (e) {
      return { error: e.message };
    }
  }

  function renderValidationRow(cellEl, validationRow) {
    ensureStylesInjected();
    // Remove any existing validation block
    const existing = cellEl.querySelector('.val-status-row');
    if (existing) existing.remove();
    const existingAnchors = cellEl.querySelector('.val-anchors');
    if (existingAnchors) existingAnchors.remove();
    const existingActions = cellEl.querySelector('.val-actions');
    if (existingActions) existingActions.remove();

    if (!validationRow) return;

    const statusInfo = STATUS_LABELS[validationRow.status] || { cls: 'val-pending', label: validationRow.status, icon: '?' };
    const statusRow = document.createElement('div');
    statusRow.className = 'val-status-row ' + statusInfo.cls;
    const iconSpan = document.createElement('span');
    iconSpan.className = 'val-icon';
    iconSpan.textContent = statusInfo.icon;
    statusRow.appendChild(iconSpan);
    statusRow.appendChild(document.createTextNode(statusInfo.label));

    const vr = validationRow.validation_result || {};
    if (typeof vr.requiredFoundCount === 'number' && typeof vr.requiredCount === 'number') {
      statusRow.appendChild(document.createTextNode(' — ' + vr.requiredFoundCount + ' / ' + vr.requiredCount + ' anchors found'));
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'val-detail-toggle';
      toggle.style.marginLeft = '8px';
      toggle.textContent = 'Show details';
      toggle.addEventListener('click', () => {
        const panel = cellEl.querySelector('.val-anchors');
        if (panel) {
          panel.classList.toggle('open');
          toggle.textContent = panel.classList.contains('open') ? 'Hide details' : 'Show details';
        }
      });
      statusRow.appendChild(toggle);
    }
    cellEl.appendChild(statusRow);

    // Anchor breakdown
    if (Array.isArray(vr.anchors) && vr.anchors.length > 0) {
      const anchorsEl = document.createElement('div');
      anchorsEl.className = 'val-anchors';
      const heading = document.createElement('div');
      heading.style.fontWeight = '600';
      heading.style.marginBottom = '4px';
      heading.textContent = 'Required anchor strings — ' + vr.requiredFoundCount + ' / ' + vr.requiredCount + ' found:';
      anchorsEl.appendChild(heading);
      vr.anchors.forEach(a => {
        const tag = document.createElement('span');
        tag.className = 'val-anchor ' + (a.found ? 'found' : 'missing');
        tag.title = a.field + (a.manualOverride ? ' (mapped manually)' : '');
        tag.textContent = (a.found ? '✓ ' : '✗ ') + a.anchor;
        anchorsEl.appendChild(tag);
      });
      cellEl.appendChild(anchorsEl);
    }

    // Action row for fail states
    const failStates = ['manual_mapping_pending', 'rejected'];
    if (failStates.includes(validationRow.status)) {
      const actions = document.createElement('div');
      actions.className = 'val-actions';

      const mapBtn = document.createElement('button');
      mapBtn.type = 'button';
      mapBtn.className = 'val-action-btn primary';
      mapBtn.textContent = 'Map anchors manually';
      mapBtn.disabled = true; // Phase 4B (deferred — coming soon)
      mapBtn.title = 'Manual anchor mapping UI is coming in the next release. For now, please use the Request admin review option or upload a template that includes the required anchor strings listed above.';
      actions.appendChild(mapBtn);

      const reviewBtn = document.createElement('button');
      reviewBtn.type = 'button';
      reviewBtn.className = 'val-action-btn secondary';
      reviewBtn.textContent = 'Request admin review';
      reviewBtn.addEventListener('click', () => requestAdminReviewForTemplate(validationRow.id, cellEl));
      actions.appendChild(reviewBtn);

      cellEl.appendChild(actions);
    }
  }

  // Public: attach validation status to an existing slot cell
  async function attachValidationStatus(cellEl, contractorId, trade, fundingType, storagePath) {
    if (!contractorId || !trade || !fundingType) return;
    let row = await findValidationRow(contractorId, trade, fundingType);
    // If a legacy template exists in JSONB but no validation row yet, create one and trigger validation
    if (!row && storagePath) {
      row = await upsertValidationRow(contractorId, trade, fundingType, storagePath);
      if (row) {
        // Fire-and-forget validate
        callValidateEdgeFunction(row.id).then(result => {
          if (result && result.validation_result) {
            row.validation_result = result.validation_result;
            row.status = result.status;
            renderValidationRow(cellEl, row);
          }
        }).catch(() => {});
      }
    }
    renderValidationRow(cellEl, row);
  }

  // Public: post-upload hook — creates contractor_templates row + calls EF
  async function validateNewlyUploadedTemplate(contractorId, trade, fundingType, storagePath, cellEl) {
    if (!contractorId || !storagePath) return null;
    const row = await upsertValidationRow(contractorId, trade, fundingType, storagePath);
    if (!row) return null;
    // Show pending state immediately
    if (cellEl) renderValidationRow(cellEl, row);
    // Call validate
    const result = await callValidateEdgeFunction(row.id);
    if (result && result.validation_result) {
      row.validation_result = result.validation_result;
      row.status = result.status;
      if (cellEl) renderValidationRow(cellEl, row);
      return row;
    }
    if (result && result.error) {
      console.error('[D-199] Validation EF error:', result.error, result.details);
      const errEl = document.createElement('div');
      errEl.className = 'val-status-row val-rejected';
      errEl.textContent = 'Validation failed — ' + result.error + '. The template was saved, but please contact support.';
      if (cellEl) cellEl.appendChild(errEl);
    }
    return row;
  }

  // Public: escalate to admin review queue
  async function requestAdminReviewForTemplate(templateId, cellEl) {
    if (!templateId) return;
    if (!confirm('Submit this template for admin review? You will be notified once Otter Quotes has reviewed it.')) return;
    if (typeof sb === 'undefined' || !sb) {
      alert('Not connected to database.');
      return;
    }
    try {
      const { data, error } = await sb
        .from('contractor_templates')
        .update({ status: 'submitted_for_admin_review' })
        .eq('id', templateId)
        .select('*')
        .single();
      if (error) throw error;
      if (cellEl && data) renderValidationRow(cellEl, data);
      else alert('Template submitted for admin review. You will be notified once it has been reviewed.');
    } catch (e) {
      console.error('[D-199] requestAdminReviewForTemplate error:', e);
      alert('Could not submit for admin review: ' + (e.message || e));
    }
  }

  // Expose
  window.D199 = {
    attachValidationStatus: attachValidationStatus,
    validateNewlyUploadedTemplate: validateNewlyUploadedTemplate,
    requestAdminReviewForTemplate: requestAdminReviewForTemplate,
  };
})();
