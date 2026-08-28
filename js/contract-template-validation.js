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

  /**
   * Normalize a funding label to the canonical vocabulary used by
   * contractor_templates.funding_type, the bid_can_submit() RPC, and the
   * validate-contract-template EF manifest: 'insurance' | 'retail'.
   *
   * #505 follow-up: contractor-settings.html's roofing slot label is
   * "Insurance (full replacement)". Lowercasing it verbatim produced
   * funding_type = 'insurance (full replacement)', which matches NOTHING —
   * findValidationRow missed, upsertValidationRow wrote a foreign value, the
   * EF 400'd with "No manifest for roofing/insurance (full replacement)", and
   * bid_can_submit('roofing','insurance') returned not_found → the D-199
   * trigger blocked every roofing insurance bid. Every other slot label
   * ('Retail', 'Insurance') happened to normalize correctly, so only the
   * platform's most important slot was broken.
   */
  function fundingKey(f)      {
    var s = String(f || '').toLowerCase();
    if (s.indexOf('insurance') !== -1) return 'insurance';
    if (s.indexOf('retail') !== -1 || s.indexOf('cash') !== -1) return 'retail';
    return s;
  }

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
      .val-marker { border-left: 3px solid #DC2626; background: #FFFFFF; padding: 8px 10px; border-radius: 4px; margin: 6px 0; }
      .val-marker-name { font-weight: 700; font-size: 0.82rem; color: #0D1B2E; }
      .val-marker-meta { font-size: 0.76rem; color: #4B5563; margin-top: 2px; }
      .val-marker-example { margin-top: 6px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      .val-marker-example code { font-family: ui-monospace, monospace; font-size: 0.74rem; background: #F3F4F6; border: 1px solid #E5E7EB; padding: 3px 6px; border-radius: 3px; word-break: break-all; }
      .val-copy-btn { padding: 3px 10px; border-radius: 4px; border: 1px solid #D1D5DB; background: #FFFFFF; font-size: 0.74rem; font-weight: 600; cursor: pointer; color: #0D1B2E; }
      .val-warn-proposal, .val-warn-notice { margin-top: 10px; padding: 10px 12px; border-radius: 6px; font-size: 0.82rem; }
      .val-warn-proposal { background: #FEF2F2; border: 1px solid #FCA5A5; color: #7F1D1D; }
      .val-warn-notice { background: #FFFBEB; border: 1px solid #FCD34D; color: #78350F; }
      .val-warn-head { font-weight: 700; margin-bottom: 4px; }
      .val-warn-proposal p, .val-warn-notice p { margin: 0 0 6px; }
      .val-warn-proposal ul { margin: 0; padding-left: 18px; }
      .val-warn-proposal li { margin-bottom: 4px; }
      .val-warn-proposal code { font-family: ui-monospace, monospace; font-size: 0.74rem; background: rgba(255,255,255,0.8); padding: 1px 4px; border-radius: 3px; }
      .val-actions { margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap; }
      .val-action-btn { padding: 6px 12px; border-radius: 4px; border: none; font-size: 0.82rem; font-weight: 600; cursor: pointer; }
      .val-action-btn.primary { background: #0D1B2E; color: white; }
      .val-action-btn.primary:disabled { background: #94A3B8; cursor: not-allowed; }
      .val-action-btn.secondary { background: #E07B00; color: white; }
      .val-action-btn.secondary:hover:not(:disabled) { background: #C26B00; }

      /* Manual mapping modal (D-199 Tier 2) */
      .val-modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 9000; display: flex; align-items: flex-start; justify-content: center; padding: 40px 16px; overflow-y: auto; }
      .val-modal { background: #FFFFFF; color: #0D1B2E; border-radius: 8px; max-width: 760px; width: 100%; box-shadow: 0 18px 50px rgba(0,0,0,0.35); }
      .val-modal-header { padding: 18px 22px; border-bottom: 1px solid #E5E7EB; display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
      .val-modal-header h3 { margin: 0; font-size: 1.15rem; color: #0D1B2E; }
      .val-modal-header p { margin: 6px 0 0; font-size: 0.9rem; color: #4B5563; }
      .val-modal-close { background: none; border: none; font-size: 1.4rem; line-height: 1; cursor: pointer; color: #6B7280; }
      .val-modal-body { padding: 18px 22px; max-height: 60vh; overflow-y: auto; }
      .val-modal-footer { padding: 14px 22px; border-top: 1px solid #E5E7EB; display: flex; justify-content: flex-end; gap: 10px; flex-wrap: wrap; }
      .val-anchor-row { padding: 14px; border: 1px solid #E5E7EB; border-radius: 6px; margin-bottom: 12px; background: #F9FAFB; }
      .val-anchor-row.choice-have { border-color: #10B981; background: #ECFDF5; }
      .val-anchor-row.choice-missing { border-color: #DC2626; background: #FEF2F2; }
      .val-anchor-row code { font-family: ui-monospace, monospace; font-size: 0.85rem; background: #FFFFFF; border: 1px solid #E5E7EB; padding: 2px 6px; border-radius: 3px; }
      .val-anchor-row .anchor-field-label { font-size: 0.78rem; color: #6B7280; margin-top: 2px; }
      .val-anchor-row .anchor-choices { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
      .val-anchor-row .anchor-choice-btn { padding: 6px 12px; border-radius: 4px; border: 1px solid #D1D5DB; background: #FFFFFF; font-size: 0.82rem; font-weight: 600; cursor: pointer; color: #0D1B2E; }
      .val-anchor-row .anchor-choice-btn.active { background: #0D1B2E; color: #FFFFFF; border-color: #0D1B2E; }
      .val-anchor-row .anchor-choice-btn.missing.active { background: #DC2626; border-color: #DC2626; }
      .val-anchor-row .anchor-input-wrap { margin-top: 10px; display: none; }
      .val-anchor-row.choice-have .anchor-input-wrap { display: block; }
      .val-anchor-row .anchor-input-wrap label { display: block; font-size: 0.82rem; color: #374151; margin-bottom: 4px; font-weight: 600; }
      .val-anchor-row .anchor-input-wrap input { width: 100%; padding: 8px 10px; border: 1px solid #D1D5DB; border-radius: 4px; font-size: 0.9rem; box-sizing: border-box; }
      .val-anchor-row .anchor-input-wrap small { display: block; margin-top: 4px; font-size: 0.75rem; color: #6B7280; }
      .val-modal-summary { background: #F3F4F6; border-radius: 6px; padding: 10px 12px; font-size: 0.85rem; margin-bottom: 14px; }
      .val-modal-error { color: #B91C1C; font-size: 0.85rem; margin-top: 8px; }
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

  // One caller for every mode of validate-contract-template: validate, the
  // #1313 starter download, and the #1313 assisted path. They share auth,
  // error shape and the JSON-or-raw-text fallback, so they share a function.
  async function callTemplateEdgeFunction(payload) {
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
        body: JSON.stringify(payload),
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

  // Call validate-contract-template Edge Function
  async function callValidateEdgeFunction(contractorTemplateId, manualOverrides) {
    return await callTemplateEdgeFunction({
      contractor_template_id: contractorTemplateId,
      manualOverrides: manualOverrides || undefined,
    });
  }

  /**
   * [#1313] Download the pre-tagged starter for a slot.
   *
   * The PDF is generated by the Edge Function from the same v3 manifest the
   * validator scans, so a downloaded starter is always current: a static asset
   * would have been correct on the day it was made and silently wrong at the
   * next manifest revision, which is exactly why every v2-era template on the
   * platform is invalid today.
   */
  async function downloadStarterTemplate(trade, fundingType, btn) {
    const label = btn ? btn.textContent : null;
    if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
    try {
      const res = await callTemplateEdgeFunction({
        starter: true, trade: tradeKey(trade), funding_type: fundingKey(fundingType),
      });
      if (res.error || !res.pdf_base64) { alert('Could not build the starter template: ' + (res.error || 'no file returned')); return; }
      const bin = atob(res.pdf_base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url; a.download = res.filename || 'otterquote-contract-template.pdf';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = label; }
    }
  }

  /**
   * [#1313] The assisted path — "add the fields for me".
   *
   * Takes the contractor's own uploaded PDF and appends a tagged execution
   * page. Doing this by hand for the first real contractor took about twenty
   * minutes. His pages are copied byte-for-byte; the original is archived
   * before the slot is replaced.
   */
  async function addFieldsForMe(validationRow, cellEl) {
    if (!confirm(
      'Otter Quotes will add a signature and fields page to the end of your uploaded PDF, and keep a copy of your original.\n\n' +
      'Your contract terms are not changed. Nothing is added to them and nothing is removed.\n\nContinue?'
    )) return;
    const res = await callTemplateEdgeFunction({
      contractor_template_id: validationRow.id, assist: true,
    });
    if (res.error) { alert('Could not add the fields: ' + res.error + (res.details?.hint ? '\n\n' + res.details.hint : '')); return; }
    const fresh = await findValidationRowById(validationRow.id);
    renderValidationRow(cellEl, fresh || { ...validationRow, status: res.status, validation_result: res.validation_result });
  }

  async function findValidationRowById(id) {
    try {
      const { data } = await sb.from('contractor_templates').select('*').eq('id', id).maybeSingle();
      return data || null;
    } catch (_) { return null; }
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

    // ── [#1313] Is this a template at all? ──────────────────────────────
    // Shown ABOVE the marker list and styled differently, because it is a
    // different problem with a different fix. The first real contractor
    // uploaded a filled sample proposal made out to himself; the validator
    // counted tags, so it failed for the same reason a blank untagged template
    // fails and said the same thing. He had no way to know.
    if (vr.filledProposal && vr.filledProposal.detected) {
      const warn = document.createElement('div');
      warn.className = 'val-warn-proposal';
      const h = document.createElement('div');
      h.className = 'val-warn-head';
      h.textContent = 'This looks like a filled-in proposal, not a blank template';
      warn.appendChild(h);
      const p = document.createElement('p');
      p.textContent = 'Upload the blank version you start every job from. Otter Quotes fills in the customer, the property and the price from the accepted bid — if those are already typed into the document, the homeowner would be asked to sign a contract naming somebody else. What we found:';
      warn.appendChild(p);
      const ul = document.createElement('ul');
      (vr.filledProposal.signals || []).forEach(sig => {
        const li = document.createElement('li');
        li.appendChild(document.createTextNode(sig.detail + ' '));
        const code = document.createElement('code');
        code.textContent = sig.sample;
        li.appendChild(code);
        ul.appendChild(li);
      });
      warn.appendChild(ul);
      cellEl.appendChild(warn);
    }

    // ── [#1313 / C1] The Notice of Cancellation ─────────────────────────
    // IC 24-5-11-10 requires the notice be furnished. Otter Quotes used to
    // generate one and attach it; Dustin retired that on 2026-08-27 because it
    // is the contractor's term to state, not ours. So it has to be in his
    // template — and a template whose terms cite "the attached Notice of
    // Cancellation" now cites an attachment nothing carries.
    if (vr.cancellationNotice && vr.cancellationNotice !== 'present') {
      const warn = document.createElement('div');
      warn.className = 'val-warn-notice';
      const h = document.createElement('div');
      h.className = 'val-warn-head';
      h.textContent = vr.cancellationNotice === 'placeholder'
        ? 'The Notice of Cancellation block is still the placeholder'
        : 'No Notice of Cancellation found in this template';
      warn.appendChild(h);
      const p = document.createElement('p');
      p.textContent = vr.cancellationNotice === 'placeholder'
        ? 'The starter template you uploaded still has our instruction block where your Notice of Cancellation belongs. Replace it with your own notice before you use this template on a real job.'
        : 'Indiana Code 24-5-11-10 requires a Notice of Cancellation be furnished with a home improvement contract. Otter Quotes does not supply one — it is a term of your agreement. If your terms already reference "the attached Notice of Cancellation", the notice needs to be in this document.';
      warn.appendChild(p);
      cellEl.appendChild(warn);
    }

    // ── [#1313] Per-marker instructions ─────────────────────────────────
    // The validator always knew exactly which markers were missing. What it
    // showed was the raw tag string with a red cross beside it, which
    // describes the failure and not the fix. Indy Rooftops scored 0 of 12 and
    // was told "Upload and validate it on your profile before bidding."
    if (Array.isArray(vr.anchors) && vr.anchors.length > 0) {
      const anchorsEl = document.createElement('div');
      anchorsEl.className = 'val-anchors';
      const heading = document.createElement('div');
      heading.style.fontWeight = '600';
      heading.style.marginBottom = '6px';
      heading.textContent = vr.requiredFoundCount + ' of ' + vr.requiredCount + ' required fields found.';
      anchorsEl.appendChild(heading);

      const markers = Array.isArray(vr.missingMarkers) ? vr.missingMarkers : [];
      if (markers.length > 0) {
        const sub = document.createElement('div');
        sub.style.marginBottom = '8px';
        sub.textContent = 'Add these to your PDF. Type each one exactly as shown, on a single line — it disappears when the document is sent and becomes the fill-in field.';
        anchorsEl.appendChild(sub);
        markers.forEach(mk => {
          const row = document.createElement('div');
          row.className = 'val-marker';
          const name = document.createElement('div');
          name.className = 'val-marker-name';
          name.textContent = mk.name;
          row.appendChild(name);
          const where = document.createElement('div');
          where.className = 'val-marker-meta';
          where.textContent = mk.where;
          row.appendChild(where);
          const why = document.createElement('div');
          why.className = 'val-marker-meta';
          why.textContent = mk.why;
          row.appendChild(why);
          const exWrap = document.createElement('div');
          exWrap.className = 'val-marker-example';
          const code = document.createElement('code');
          code.textContent = mk.example;
          exWrap.appendChild(code);
          const copy = document.createElement('button');
          copy.type = 'button';
          copy.className = 'val-copy-btn';
          copy.textContent = 'Copy';
          copy.addEventListener('click', () => {
            navigator.clipboard.writeText(mk.example).then(
              () => { copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1600); },
              () => { copy.textContent = 'Press Ctrl+C'; }
            );
          });
          exWrap.appendChild(copy);
          row.appendChild(exWrap);
          anchorsEl.appendChild(row);
        });
      }

      const foundList = vr.anchors.filter(a => a.found);
      if (foundList.length > 0) {
        const okHead = document.createElement('div');
        okHead.style.fontWeight = '600';
        okHead.style.margin = '10px 0 4px';
        okHead.textContent = 'Already in your PDF:';
        anchorsEl.appendChild(okHead);
        foundList.forEach(a => {
          const tag = document.createElement('span');
          tag.className = 'val-anchor found';
          tag.title = a.anchor;
          tag.textContent = '✓ ' + (a.field || a.anchor);
          anchorsEl.appendChild(tag);
        });
      }
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
      mapBtn.title = 'Tell us the actual labels you used in your PDF for each missing field. We will re-validate against your input.';
      mapBtn.addEventListener('click', () => openManualMappingModal(validationRow, cellEl));
      actions.appendChild(mapBtn);

      // [#1313 piece 4] The assisted path, offered FIRST because it is the one
      // that actually closes the issue: a contractor who has never seen a
      // BoldSign text tag gets to auto_validated without a human doing it for
      // him. "Map anchors manually" still assumes he can edit a PDF.
      const assistBtn = document.createElement('button');
      assistBtn.type = 'button';
      assistBtn.className = 'val-action-btn primary';
      assistBtn.textContent = 'Add the fields for me';
      assistBtn.title = 'Otter Quotes adds a signature and fields page to the end of your PDF. Your terms are not changed.';
      assistBtn.addEventListener('click', () => addFieldsForMe(validationRow, cellEl));
      actions.insertBefore(assistBtn, actions.firstChild);

      const starterBtn = document.createElement('button');
      starterBtn.type = 'button';
      starterBtn.className = 'val-action-btn secondary';
      starterBtn.textContent = 'Download blank starter';
      starterBtn.title = 'A blank, pre-tagged template for this trade and funding type. Paste your own terms into it.';
      starterBtn.addEventListener('click', () => downloadStarterTemplate(validationRow.trade, validationRow.funding_type, starterBtn));
      actions.appendChild(starterBtn);

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

  // ──────────────────────────────────────────────────────────────────────
  // D-199 Tier 2 — Manual anchor mapping modal
  // ──────────────────────────────────────────────────────────────────────

  function escapeAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function openManualMappingModal(validationRow, cellEl) {
    if (!validationRow || !validationRow.id) return;
    ensureStylesInjected();

    const vr = validationRow.validation_result || {};
    const missing = (Array.isArray(vr.anchors) ? vr.anchors : []).filter(a => !a.found);
    if (missing.length === 0) return;

    // Build modal DOM
    const backdrop = document.createElement('div');
    backdrop.className = 'val-modal-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');

    const modal = document.createElement('div');
    modal.className = 'val-modal';

    // Header
    const header = document.createElement('div');
    header.className = 'val-modal-header';
    const headerInner = document.createElement('div');
    const h3 = document.createElement('h3');
    h3.textContent = 'Map missing fields in your PDF';
    headerInner.appendChild(h3);
    const p = document.createElement('p');
    p.textContent = 'For each field below, tell us the exact label you used in your PDF, or confirm your PDF does not contain it. We will re-validate against your input.';
    headerInner.appendChild(p);
    header.appendChild(headerInner);
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'val-modal-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => backdrop.remove());
    header.appendChild(closeBtn);
    modal.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'val-modal-body';

    const summary = document.createElement('div');
    summary.className = 'val-modal-summary';
    summary.textContent = missing.length + ' of ' + (vr.requiredCount || missing.length) + ' required anchors were not found in your uploaded PDF. Map each one below.';
    body.appendChild(summary);

    // For each missing anchor: render a row with two choice buttons + conditional input
    const rowState = []; // [{ anchor, choice: 'have'|'missing'|null, value: string }]
    missing.forEach((a, idx) => {
      const state = { anchor: a.anchor, choice: null, value: '' };
      rowState.push(state);

      const row = document.createElement('div');
      row.className = 'val-anchor-row';
      row.dataset.anchor = a.anchor;

      const expectedLine = document.createElement('div');
      expectedLine.innerHTML = '<strong>Expected anchor:</strong> ';
      const code = document.createElement('code');
      code.textContent = a.anchor;
      expectedLine.appendChild(code);
      row.appendChild(expectedLine);

      const fieldLabel = document.createElement('div');
      fieldLabel.className = 'anchor-field-label';
      fieldLabel.textContent = a.field + (a.source ? ' · ' + a.source : '');
      row.appendChild(fieldLabel);

      // Choices
      const choices = document.createElement('div');
      choices.className = 'anchor-choices';
      const haveBtn = document.createElement('button');
      haveBtn.type = 'button';
      haveBtn.className = 'anchor-choice-btn';
      haveBtn.textContent = 'My PDF has this (different label)';
      const missBtn = document.createElement('button');
      missBtn.type = 'button';
      missBtn.className = 'anchor-choice-btn missing';
      missBtn.textContent = 'My PDF does not have this field';
      choices.appendChild(haveBtn);
      choices.appendChild(missBtn);
      row.appendChild(choices);

      // Input wrap (shown only on "have" choice)
      const inputWrap = document.createElement('div');
      inputWrap.className = 'anchor-input-wrap';
      const inputLabel = document.createElement('label');
      inputLabel.textContent = 'Type the exact label/text from your PDF for this field:';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'e.g., ' + a.anchor.replace(/[\/]/g, '');
      input.addEventListener('input', () => { state.value = input.value; });
      inputWrap.appendChild(inputLabel);
      inputWrap.appendChild(input);
      const helper = document.createElement('small');
      helper.textContent = 'Case-sensitive. Match the text exactly as it appears in your PDF.';
      inputWrap.appendChild(helper);
      row.appendChild(inputWrap);

      const setChoice = (c) => {
        state.choice = c;
        haveBtn.classList.toggle('active', c === 'have');
        missBtn.classList.toggle('active', c === 'missing');
        row.classList.toggle('choice-have', c === 'have');
        row.classList.toggle('choice-missing', c === 'missing');
        if (c === 'have') {
          setTimeout(() => input.focus(), 50);
        }
      };
      haveBtn.addEventListener('click', () => setChoice('have'));
      missBtn.addEventListener('click', () => setChoice('missing'));

      body.appendChild(row);
    });

    const errEl = document.createElement('div');
    errEl.className = 'val-modal-error';
    body.appendChild(errEl);
    modal.appendChild(body);

    // Footer
    const footer = document.createElement('div');
    footer.className = 'val-modal-footer';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'val-action-btn secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => backdrop.remove());
    footer.appendChild(cancelBtn);

    const submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'val-action-btn primary';
    submitBtn.textContent = 'Submit for re-validation';
    footer.appendChild(submitBtn);

    submitBtn.addEventListener('click', async () => {
      errEl.textContent = '';
      // Validate state
      const incomplete = rowState.filter(s => s.choice === null);
      if (incomplete.length > 0) {
        errEl.textContent = 'Please make a choice for each field before submitting (' + incomplete.length + ' remaining).';
        return;
      }
      const haveButEmpty = rowState.filter(s => s.choice === 'have' && (!s.value || !s.value.trim()));
      if (haveButEmpty.length > 0) {
        errEl.textContent = 'Please type the actual label for each "My PDF has this" entry.';
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting…';

      const overrides = {};
      const missingFields = [];
      rowState.forEach(s => {
        if (s.choice === 'have') overrides[s.anchor] = s.value.trim();
        else if (s.choice === 'missing') missingFields.push(s.anchor);
      });

      try {
        // If the contractor marked any field as completely absent, we cannot self-validate —
        // route the whole template to admin review with the typed alts attached as context.
        if (missingFields.length > 0) {
          if (typeof sb === 'undefined' || !sb) throw new Error('Database not connected.');
          // First, persist the typed mappings so admin can see them
          const { error: persistErr } = await sb
            .from('contractor_templates')
            .update({
              manual_overrides: { ...overrides, _missing_fields: missingFields },
              status: 'submitted_for_admin_review',
            })
            .eq('id', validationRow.id);
          if (persistErr) throw persistErr;
          backdrop.remove();
          // Refresh the row in UI by re-fetching
          const { data: refreshed } = await sb
            .from('contractor_templates')
            .select('*')
            .eq('id', validationRow.id)
            .single();
          if (refreshed && cellEl) renderValidationRow(cellEl, refreshed);
          alert('Submitted for admin review. We will notify you once a member of the Otter Quotes team has looked at your template.');
          return;
        }

        // Otherwise: call the EF for re-validation against typed overrides
        const result = await callValidateEdgeFunction(validationRow.id, overrides);
        if (result && result.error) {
          errEl.textContent = 'Validation error: ' + result.error;
          submitBtn.disabled = false;
          submitBtn.textContent = 'Submit for re-validation';
          return;
        }
        backdrop.remove();
        // Refresh row
        if (typeof sb !== 'undefined' && sb) {
          const { data: refreshed } = await sb
            .from('contractor_templates')
            .select('*')
            .eq('id', validationRow.id)
            .single();
          if (refreshed && cellEl) renderValidationRow(cellEl, refreshed);
        }
        if (result && result.status === 'manual_validated') {
          alert('Validated. Your template now passes all required anchors and is ready for use on bids.');
        } else if (result && result.status === 'manual_mapping_pending') {
          alert('Some labels you provided still could not be matched in your PDF. Please double-check spelling and capitalization, or use "Request admin review" if you need help.');
        }
      } catch (err) {
        console.error('[D-199] manual mapping submit error:', err);
        errEl.textContent = 'Submission failed: ' + (err.message || err);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit for re-validation';
      }
    });

    modal.appendChild(footer);
    backdrop.appendChild(modal);

    // ESC closes
    backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') backdrop.remove(); });
    // Click outside modal closes
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });

    document.body.appendChild(backdrop);
    setTimeout(() => closeBtn.focus(), 30);
  }

  // Expose
  window.D199 = {
    attachValidationStatus: attachValidationStatus,
    validateNewlyUploadedTemplate: validateNewlyUploadedTemplate,
    requestAdminReviewForTemplate: requestAdminReviewForTemplate,
    openManualMappingModal: openManualMappingModal,
    // [#1313] Exposed so the onboarding wizard and the settings card can offer
    // the starter before a contractor has uploaded anything at all — which is
    // the moment it is most useful. The in-card buttons above call the same
    // functions.
    downloadStarterTemplate: downloadStarterTemplate,
    addFieldsForMe: addFieldsForMe,
  };
})();
