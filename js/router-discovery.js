// gh-2017: Variant C -- the Sandler-style discovery engine, its shared entry
// screen, and the homeowner track (8 screens, 4 disqualifier branches).
//
// This is a MODULE, not a second page (issue #2011's own URL requirement is
// what decides that -- /start?v=c has to stay /start). start.html loads this
// file by injecting a <script> element ONLY when variant === 'c', then calls
// window.RouterDiscovery.init(bridge, root) once it has loaded. Arms A and B
// never fetch or execute this file at all (#2015: /start?v=a must render
// exactly what /start renders).
//
// This module owns its OWN ordered-array screen sequencer and its OWN
// rendering. It does not touch, extend, or call into start.html's
// steps/renderStep/doneCount/popstate machinery (that file's own three
// "fix round" comment blocks record how bug-scarred that code already is
// for a flat 4-key object -- #2017 explicitly rejects growing its state
// space tenfold). Everything this module needs FROM start.html arrives
// through the `bridge` object passed to init() -- called, never copied:
// sb, trackRouter, collectAttribution, insertFreshLead, appendParams,
// redirectTo, showError, ROLE_DESTINATIONS, PARTNER_INDUSTRY_DESTINATIONS,
// NO_LEAD_ID_DESTINATIONS.
//
// Contact capture: public.leads.email is NOT NULL (verified live against
// project yeszghaspzwwstvsrioa, 2026-09-18) with no default, so screens
// c-entry through c-home-7 write NOTHING to the database -- every answer is
// held in the `answers` object below, client-side only, until c-home-8's
// contact submit. Never invent a placeholder email to insert earlier; a
// synthetic address corrupts the table the funnel reports from.
//
// THE CARVE-OUT (draft #2019, not yet landed): every disqualifier screen's
// option 2 ("Yes, please send me their contact information.") is D-8 and
// belongs to #2019. This module builds the capture (one field, email only,
// no name, no phone, no second screen, no new tab -- 78% of this traffic is
// mobile and 39% is the Facebook in-app browser) and wires router_disqualified,
// but the outbound message a homeowner would receive is Tier C copy that
// belongs to Dustin, not this module -- see the QUESTIONS field in this PR's
// report. DO NOT point live ad traffic at /start?v=c until #2019 lands.
//
// Step tokens (exact, namespaced so they cannot collide with arm A's
// 1/2/2a/3 or arm B's b-*): c-entry, c-home-1..c-home-8,
// c-home-dq-4/5/6/7. router_step_view fires on entry to EVERY token in that
// list (dq screens included). router_step_complete fires on leaving one.
// router_disqualified fires on entry to a c-home-dq-* screen, carrying the
// ORIGINAL screen's token (e.g. step: 'c-home-7', not 'c-home-dq-7') -- this
// is the D-2 control's own shape (issue #2017's closes-on control 1) and is
// how the funnel learns WHICH question ended the session. Never emit a
// guessed step token -- a missing event is a hole we can see; a wrong one
// is not.
(function () {
  'use strict';

  var bridge = null;
  var root = null;

  // Every answer is held here, client-side, only for as long as the
  // session lasts -- cleared implicitly on page reload (no resume-a-
  // session feature is asked for). None of these six fields is written
  // to public.leads by this issue: the table has no column for any of
  // them (verified live, 2026-09-18 -- trades/payer/hidden-cost/
  // time-investment/selection-criteria/online-comfort do not exist as
  // leads columns), and the work order's own contact-capture section
  // scopes the c-home-8 insert to insertFreshLead()+set_lead_role() only.
  // Held here anyway (rather than discarded on read) so a later issue
  // that DOES need this scope-of-work detail -- c-home-8's own copy says
  // "we will get additional information about your job" as a step AFTER
  // this one -- has it in one place instead of re-deriving it.
  var answers = {
    trades: [],
    payer: null,
    hiddenCosts: [],
    timeInvestment: null,
    selectionCriteria: [],
    online: null
  };

  // Module-owned navigation stack (NOT the browser's history/popstate --
  // this module does not push history entries; a hardware/browser Back
  // simply leaves /start?v=c, which is an acceptable default for this
  // build). `activeToken` is the screen currently rendered; `stack` holds
  // the tokens to return to when this module's own on-screen "Back"
  // control is used.
  var activeToken = null;
  var stack = [];

  // Review fix (PR #2032, comment 5732876137): router_disqualified fires
  // AT MOST ONCE per (session, disqualifying source screen), keyed here by
  // that source token. router_step_view is NOT deduped -- a view is a view,
  // and arm A/B deliberately re-emit views on back-then-forward (see
  // start.html's renderStep comment: "counts as a view too, matching
  // back-then-forward funnel semantics"). Only the disqualified signal is
  // once-per-encounter, because it is the number the whole variant test is
  // judged on (which question kills the session) -- a visitor who lands on
  // a dq screen, goes Back, then re-enters the same dq screen did not
  // disqualify twice, and counting it twice fabricates a result at this
  // traffic volume (~3 real sessions/day). A dedupe set keyed on the
  // source token was chosen over a forward/back flag threaded through
  // show()/goBack(): it guarantees the once-per-encounter invariant for
  // EVERY path that can re-enter a dq screen, not just the one Back button
  // this file currently wires up -- including any future screen that adds
  // a way back past a dq screen and forward through the same disqualifying
  // answer again. A flag would only have covered today's one reachable
  // path. Do not "fix" this back into an unconditional emit in show().
  var disqualifiedFired = {};

  // Maps a disqualifier screen's own view token to the ORIGINAL screen
  // token that fired it -- the value router_disqualified's `step` carries
  // (D-2 control: option 1 on c-home-7 -> router_disqualified step=c-home-7,
  // not step=c-home-dq-7).
  var DQ_SOURCE = {
    'c-home-dq-4': 'c-home-4',
    'c-home-dq-5': 'c-home-5',
    'c-home-dq-6': 'c-home-6',
    'c-home-dq-7': 'c-home-7'
  };

  // ── Approved copy -- ship verbatim, byte-exact. Dustin has declined
  // three times in his own voice to alter these words on this build
  // (#2011 D-1, D-4; #2019 "A."). Screen 4 option 3's EN DASH (U+2013,
  // "10–15%") is intentional and must not be normalized to a hyphen by an
  // editor/linter -- byte-verified in this PR's evidence. ──
  var COPY = {
    entryIntro: 'Thanks for coming. Please tell us why you are here:',
    entryOptions: [
      'I am a homeowner looking for competitive bids on an upcoming project.',
      'I am a professional interested in new ways to help my clients.',
      'I am a contractor interested in bidding on pre-scoped jobs.'
    ],
    home1: 'Great. Thank you for being here. Before we ask you for anything, we want to make sure this is a good fit for you and for us. So we just have a few questions to make sure we can serve your needs. If it\'s a great fit, we\'d love to help. If it\'s not, we\'d love to recommend someone who can. If that sounds fair, let\'s begin.',
    home2Heading: 'What kind of work do you need done (check all that apply).',
    home2Options: ['Roofing', 'Siding', 'Gutters', 'Windows', 'Other'],
    home3Heading: 'Who is paying for this work?',
    home3Options: ['Me', 'Insurance'],
    home4Heading: 'Every job includes the cost of labor and material. Which additional expenses would you like to have hidden in each line item (check all that apply):',
    // gh-2017: option 3's en dash is a real Unicode EN DASH (U+2013), not a
    // hyphen-minus -- copied here directly from the exec:cro-approved
    // source (issue #2011 body / #2017 comment 5731882071), not retyped.
    home4Options: [
      'Marketing expenses',
      'A $1000 / month truck payment',
      'A 10–15% commission for the sales rep',
      'An extra 40% for the general contractor',
      'None of the above'
    ],
    dq4Text: 'Otter Quotes is designed for homeowners who are trying to avoid the unnecessary costs in home renovation. If these things matter to you, we would be happy to send you the contact information for contractors who include these costs in their jobs.',
    dq4Opt1: 'Of course I want to save money - let\'s continue.',
    home5Heading: 'How much time do you want to invest in picking a contractor?',
    home5Options: [
      'As little as possible. Just get it done.',
      'I want to make a well informed decision, but I don\'t want to waste time.',
      'I love sitting at my kitchen table with sales people. How many can you send?'
    ],
    // OWED 1 -- exec:cro sign-off, #2017 comment 5731882071.
    dq5Text: 'Otter Quotes is built to get you good bids without the sales calls. If you would rather work with a sales rep at your kitchen table, we would be happy to send you the contact information for contractors who work that way.',
    dq5Opt1: 'I\'d rather skip the sales calls - let\'s continue.',
    home6Heading: 'What is important to you in selecting a contractor? (Select all that apply)',
    home6Options: [
      'Great Reviews',
      'Known and recommended by people in the industry',
      'Materials',
      'Warranties',
      'Quality of work',
      'The sales rep\'s brand of truck',
      'The truck wrap',
      'Whether the sales rep used the right sales technique to make me feel warm and fuzzy',
      'Price'
    ],
    // OWED 2 -- exec:cro sign-off, #2017 comment 5731882071.
    dq6Text: 'Otter Quotes is designed for homeowners who choose a contractor on the work - reviews, materials, warranties, and price. If the truck and the sales pitch are what matter to you, we would be happy to send you the contact information for contractors who spend their money there.',
    dq6Opt1: 'I\'d rather judge the work - let\'s continue.',
    home7Heading: 'How do you feel about doing business online?',
    home7Options: [
      'It\'s a fad. I need to look someone\'s sales rep in the eye before I do business with their company.',
      'It allows me to get relevant data and make relevant comparisons without the pressure of someone sitting at my kitchen table.'
    ],
    // OWED 3 -- exec:cro sign-off, #2017 comment 5731882071. Fires on
    // option 1 (D-2, ruled) -- option 2 QUALIFIES and continues to c-home-8.
    dq7Text: 'Otter Quotes is an online service, so everything happens here on the site. If you would rather have a sales rep in your living room before you decide, we would be happy to send you the contact information for contractors who do business that way.',
    dq7Opt1: 'I\'ll give the online version a try - let\'s continue.',
    home8Text: 'From our stand point, it seems like you would be a good fit. You are a tech savvy homeowner who wants to save time and money. The next steps are: 1. We will get additional information about your job; 2. We will create a scope of work and submit it to multiple contractors for bids. 3. Their bids will appear here on the site. 4. If one of the bids suits your needs, you select your contractor on the site and schedule your job. There is no obligation to work with us or our contractors. They don\'t get your information unless you select them. Our service is free to homeowners. To get started we need the following information:',

    // ── gh-2018: Variant C professional tracks (realtor, insurance,
    // contractor). Industry-picker heading/sub match start.html's own
    // #step2a copy verbatim -- this screen is the SAME question asked by
    // arm A/B's Step 2a, not a rewritten one, per the work order's "reuses
    // what exists" instruction. Its options are sourced at render time from
    // window.AgentTypes.CHOOSER_LABELS (js/agent-types.js), never
    // hand-copied here -- a local label map anywhere in this repo is a CI
    // failure (tools/agent_type_labels_check.py). ──
    profEntryHeading: 'What industry are you in?',
    profEntrySub: 'This tells us which partner program fits you.',

    // ── REALTOR -- Dustin's copy, verbatim (#2011 body; confirmed byte-
    // for-byte against #2018 comment 5731890771). Ships unaltered: D-1
    // ("I'd like it to stay") means question 4 carries no fee sentence, no
    // asterisk, no footnote -- that sentence lives on c-realtor-close only,
    // where the program is actually described. ──
    realtorQ1Heading: 'What would you like to get for your clients?',
    realtorQ1Options: [
      'Make buying / selling a home easier',
      'Reduce the cost of items that fail inspection',
      'Spend less time finding quality contractors',
      'Get them into their new home quicker'
    ],
    realtorQ2Heading: 'What is your biggest concern when a roof fails inspection?',
    realtorQ2Options: [
      'The cost of the repair could kill the deal',
      'It will delay closing',
      'The amount of time I\'ll need to invest in helping the homeowner find a contractor'
    ],
    realtorQ3Heading: 'How much effort do you want to put in to finding contractors for your clients?',
    realtorQ3Options: [
      'None. They are on their own.',
      'I would love to solve their problem with the push of a button',
      'Calling contractors keeps me from getting bored at little league games'
    ],
    // D-1, settled (Dustin, verbatim, #2011): "The rule shouldn't apply to
    // this. It's not describing or giving terms about our program. Just
    // asking if they'd like to make $200. I'd like it to stay." No fee
    // sentence, no asterisk, no footnote on this screen -- do not add one.
    realtorQ4Heading: 'Would you like an extra $200 for solving your client\'s problems?',
    realtorQ4Options: ['Yes.', 'Heck yes.', 'Duh.', 'I only use crypto.'],
    // c-realtor-close: three paragraphs, all Dustin/exec:cro-approved,
    // rendered as separate <p> elements (not one blob) so each is legible
    // on its own on the mobile rail this arm targets. Do not reorder,
    // trim, or merge these -- each paragraph's provenance is independent:
    //   1. Dustin's close, verbatim INCLUDING the app sentence -- cleared by
    //      Dustin himself (#2018 comment 5731946855: "Yes. You've built it.
    //      I use it."). Ships intact, no cut, no hedge, no asterisk.
    //   2. The one approved referral-fee sentence (D-286/D-301), verbatim,
    //      character for character -- do not improve it.
    //   3. The D-266 disclaimer, verbatim, 126 bytes, Dustin-dictated and
    //      final -- typed out here (not shared via a variable with the
    //      insurance close below) because both occurrences must be visible
    //      as literal, human-checkable text on the surfaces where they are
    //      actually displayed to a user.
    realtorClose: [
      'It sounds like you might be a great fit for our realtor referral program. We just need to collect some information from you so we can set up your referral link. After that, you just download the app and it will send your link to any client who needs our services. It costs nothing to join.',
      '$200 when a homeowner you refer completes a project of $10,000 or more. $50 on the same terms for referrals from partners you recruit.',
      'Check your employment agreement and your governing licensing agency to make sure it is lawful for you to accept referral fees.'
    ],

    // ── INSURANCE -- Dustin's copy, verbatim (#2011 body; confirmed
    // byte-for-byte against #2018 comment 5731890771). D-4 settled, Dustin
    // verbatim: "I'm going to leave it in there. There are a shocking
    // number of agents who think this practice is legal and even encourage
    // it." Questions 5 and 6 ship exactly as supplied -- each option
    // describes a practice the reader might choose, never a named company
    // and never a claim that any identified party does it. Question 2's
    // ranges and question 4's "$500-$1,500"-style dash are real Unicode EN
    // DASHES (U+2013), copied here directly rather than retyped by hand --
    // do not let an editor/linter normalize them to a hyphen-minus. The
    // 2" in question 4 is a straight ASCII double-quote (inches), not a
    // curly quote. ──
    insQ1Heading: 'How do your clients feel about saving money?',
    insQ1Options: ['They love it.', 'They don\'t care.'],
    insQ2Heading: 'How much do your clients save if they have a hail resistant shingle?',
    insQ2Options: ['0–10%', '10–20%', '20–30%', '30% or more.'],
    insQ3Heading: 'How often do you want to replace your clients\' roofs?',
    insQ3Options: [
      'As many times as possible. I\'m not signing those checks.',
      'Fewer claims save everyone money.'
    ],
    insQ4Heading: 'What type of shingle would you like on your clients\' roofs?',
    insQ4Options: [
      'Cheap contractor grade three tab. Stiff breeze, new roof, right?',
      'Entry level architectural. Get a new roof every 10 to 15 years.',
      'Hail resistant architectural. Wind rated to 135 mph and hail resistant up to 2".',
      'Hail resistant architectural with a 25 year algae warranty. Bullet proof and always looks brand new.'
    ],
    insQ5Heading: 'What type of warranty should your clients get?',
    insQ5Options: [
      'A contractor backed warranty that is worthless as soon as that company folds.',
      'Top of the line labor and material warranties backed by both the contractor and the billion dollar, publicly traded companies that made the shingles.'
    ],
    insQ6Heading: 'What process will get your clients the best outcome after a storm?',
    insQ6Options: [
      'Look for someone who waives deductibles and uses the cheapest materials.',
      'Sign a contingency agreement with a door knocker and hope they throw in good materials and warranties for free.',
      'Have multiple contractors compete for the work by offering the best materials and warranties.'
    ],
    insQ7Heading: 'What do you currently do to help your clients get the best outcomes from their claim?',
    insQ7Options: [
      'I refer my buddy who owns a roofing company',
      'I tell them to get three bids',
      'I proactively educate my clients on the discounts available and techniques for getting as much as they can from their insurance claim.'
    ],
    // c-ins-close: APPROVED STRING, #2018 comment 5731890771 § 1 -- four
    // paragraphs, exact order, disclaimer in the BODY above the contact
    // fields (not a footer, not a disclosure toggle). Deliberately absent
    // and must STAY absent: the word "realtor" (#2011's original defect
    // closed this path with "our realtor referral program"), and any app
    // promise (that sentence belongs to the realtor close only, since
    // whether an insurance-specific equivalent exists was never verified).
    insClose: [
      'It sounds like you could be a good fit for the Otter Quotes referral partner program. We just need a little information from you so we can set up your referral link. When you send it to a client, they get multiple contractors competing for their project instead of taking the first bid that knocks.',
      '$200 when a homeowner you refer completes a project of $10,000 or more. $50 on the same terms for referrals from partners you recruit.',
      'Check your employment agreement and your governing licensing agency to make sure it is lawful for you to accept referral fees.',
      'It costs nothing to join.'
    ],

    // ── CONTRACTOR -- exec:cro-approved (#2018 comment 5731890771 § 2).
    // D-266 is NOT required here -- a contractor is not a referral
    // partner. Screen 5 is the approved platform-fee sentence, verified
    // true against contractor-bid-form.html's live #feeDollarDisplay +
    // required acceptance checkbox (issue #2018 comment 5732288772) --
    // ships whole, including "the exact dollar amount for that job is
    // shown to you before you submit your bid". No hardcoded "5%" is
    // added anywhere on this screen: the fee is variable by job type and
    // value via platform_fee_config, and this sentence states the
    // structure rather than a figure that would go stale on the first
    // config change. ──
    contractorQ1Heading: 'How do you get most of your work today?',
    contractorQ1Options: [
      'Door knocking / canvassing',
      'Referrals and repeat customers',
      'Leads I buy',
      'Insurance restoration work'
    ],
    contractorQ2Heading: 'What does it cost you to win one job?',
    contractorQ2Options: ['I don\'t track it', 'Under $500', '$500–$1,500', 'More than $1,500'],
    contractorQ3Heading: 'How many appointments do you sit before you sign one?',
    contractorQ3Options: ['1–2', '3–5', 'More than 5'],
    contractorQ4Heading: 'What would you rather do with that time?',
    contractorQ4Options: [
      'Bid jobs that are already scoped and ready',
      'Keep running appointments to qualify people'
    ],
    contractorQ5Text: 'Our jobs arrive pre-scoped: the homeowner is qualified, the measurements are done, and you bid against a known scope. It costs nothing to bid. A platform fee applies only when the homeowner signs your contract, and the exact dollar amount for that job is shown to you before you submit your bid. Does that fit how you want to grow?'
  };

  // ── gh-2088 (PR #2088 round 1, item 6): export-only data describing arm
  // C's own professional-track structure, so a caller (js/router-variant-e.js)
  // can drive these exact questions generically instead of forking each one
  // into its own hand-written renderer. Nothing here is read by arm C's own
  // RENDERERS below -- they keep their existing hand-written form, byte for
  // byte, so this is purely additive and changes no behaviour for arm C.
  // PARTNER_INDUSTRY_ORDER duplicates RENDERERS['c-prof-entry']'s own local
  // `order` array literal (kept separate, not refactored to share one
  // variable, so this addition cannot alter that screen's existing,
  // already-shipped behaviour) -- the two must be kept in sync by hand if
  // arm C's own industry order ever changes.
  var PARTNER_INDUSTRY_ORDER = ['re_agent', 'insurance_agent', 'home_inspector', 'adjuster', 'other'];
  var REALTOR_TRACK = [
    { headingKey: 'realtorQ1Heading', optionsKey: 'realtorQ1Options', answerKey: 'realtorQ1' },
    { headingKey: 'realtorQ2Heading', optionsKey: 'realtorQ2Options', answerKey: 'realtorQ2' },
    { headingKey: 'realtorQ3Heading', optionsKey: 'realtorQ3Options', answerKey: 'realtorQ3' },
    { headingKey: 'realtorQ4Heading', optionsKey: 'realtorQ4Options', answerKey: 'realtorQ4' }
  ];
  var INSURANCE_TRACK = [
    { headingKey: 'insQ1Heading', optionsKey: 'insQ1Options', answerKey: 'insQ1' },
    { headingKey: 'insQ2Heading', optionsKey: 'insQ2Options', answerKey: 'insQ2' },
    { headingKey: 'insQ3Heading', optionsKey: 'insQ3Options', answerKey: 'insQ3' },
    { headingKey: 'insQ4Heading', optionsKey: 'insQ4Options', answerKey: 'insQ4' },
    { headingKey: 'insQ5Heading', optionsKey: 'insQ5Options', answerKey: 'insQ5' },
    { headingKey: 'insQ6Heading', optionsKey: 'insQ6Options', answerKey: 'insQ6' },
    { headingKey: 'insQ7Heading', optionsKey: 'insQ7Options', answerKey: 'insQ7' }
  ];
  var CONTRACTOR_TRACK = [
    { headingKey: 'contractorQ1Heading', optionsKey: 'contractorQ1Options', answerKey: 'contractorQ1' },
    { headingKey: 'contractorQ2Heading', optionsKey: 'contractorQ2Options', answerKey: 'contractorQ2' },
    { headingKey: 'contractorQ3Heading', optionsKey: 'contractorQ3Options', answerKey: 'contractorQ3' },
    { headingKey: 'contractorQ4Heading', optionsKey: 'contractorQ4Options', answerKey: 'contractorQ4' }
  ];

  // ── Small DOM helpers. Reuse the CSS classes start.html's own <style>
  // block already defines (.role-options/.role-option/.router-sub/
  // .form-group/.form-label/.form-input/.field-error/.router-btn/
  // .router-back) rather than adding a stylesheet -- this file's whitelist
  // is js/router-discovery.js and start.html only, no .css file. Any
  // "selected" row highlight below is applied as inline style using the
  // same CSS variables/values that class's own :hover rule already uses
  // (var(--amber) / rgba(224,123,0,0.08)), not a new visual language. ──
  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function clearRoot() {
    while (root.firstChild) root.removeChild(root.firstChild);
  }

  function heading(text) { return el('h1', null, text); }
  function bodyText(text) { return el('p', 'router-sub', text); }

  function optionsWrap() { return el('div', 'role-options'); }

  // A single tappable row. `onActivate` fires on click unless the row is
  // disabled. `showArrow` draws the same "&rarr;" affordance start.html's
  // own arm A/B role rows already use; multi-select rows draw a checkmark
  // slot instead, toggled by setRowSelected().
  function optionRow(label, optionIndex, opts) {
    opts = opts || {};
    var btn = el('button', 'role-option', null);
    btn.type = 'button';
    btn.setAttribute('data-rd-option', String(optionIndex));
    var labelSpan = el('span', null, label);
    btn.appendChild(labelSpan);
    var marker = el('span', 'role-arrow', opts.multi ? '' : '→');
    marker.setAttribute('data-rd-marker', '1');
    btn.appendChild(marker);
    if (opts.disabled) {
      btn.disabled = true;
      btn.style.opacity = '0.4';
      btn.style.cursor = 'not-allowed';
    } else if (typeof opts.onActivate === 'function') {
      btn.addEventListener('click', function () {
        if (btn.disabled) return;
        opts.onActivate(btn);
      });
    }
    return btn;
  }

  function setRowSelected(btn, selected) {
    btn.setAttribute('data-rd-selected', selected ? '1' : '0');
    btn.style.borderColor = selected ? 'var(--amber)' : '';
    btn.style.background = selected ? 'rgba(224,123,0,0.08)' : '';
    var marker = btn.querySelector('[data-rd-marker]');
    if (marker) marker.textContent = selected ? '✓' : '';
  }

  function continueButton(label, onClick, startEnabled) {
    var btn = el('button', 'btn btn-primary router-btn', label || 'Continue');
    btn.type = 'button';
    btn.setAttribute('data-rd-continue', '1');
    btn.disabled = !startEnabled;
    btn.addEventListener('click', function () {
      if (btn.disabled) return;
      onClick();
    });
    return btn;
  }

  // ── Tracking. Every call goes through the bridged trackRouter -- this
  // module never calls gtag directly and never touches start.html's
  // trackStepComplete/renderStep (those two are no-ops for arm C anyway,
  // per start.html's own ARM_C guards, precisely so this module's calls
  // through bridge.redirectTo below cannot double-emit a wrong token). ──
  function emitView(token) { bridge.trackRouter('router_step_view', { step: token }); }
  function emitComplete(token) { bridge.trackRouter('router_step_complete', { step: token }); }
  function emitDisqualified(sourceToken) { bridge.trackRouter('router_disqualified', { step: sourceToken }); }

  var RENDERERS = {}; // populated below, keyed by token

  function show(token) {
    activeToken = token;
    clearRoot();
    // Always re-emitted, including on a Back-then-forward re-entry -- see
    // disqualifiedFired's own comment above for why this one is NOT deduped.
    emitView(token);
    var dqSource = DQ_SOURCE[token];
    if (dqSource && !disqualifiedFired[dqSource]) {
      disqualifiedFired[dqSource] = true;
      emitDisqualified(dqSource);
    }
    RENDERERS[token]();
  }

  function go(token) {
    if (activeToken) emitComplete(activeToken);
    stack.push(activeToken);
    show(token);
  }

  function goBack() {
    if (!stack.length) return;
    if (activeToken) emitComplete(activeToken);
    show(stack.pop());
  }

  function backButton() {
    var btn = el('button', 'router-back', null);
    btn.type = 'button';
    btn.innerHTML = '&larr; Back';
    btn.addEventListener('click', goBack);
    return btn;
  }

  // ── Multi-select screens (2, 4, 6): large tappable rows + a persistent
  // Continue button, never a native <select multiple> -- close to
  // unusable in the Facebook in-app browser (39% of this traffic). ──
  function renderMultiSelect(cfg) {
    var wrap = optionsWrap();
    var selected = {};
    cfg.options.forEach(function (label, i) {
      var idx = i + 1;
      var row = optionRow(label, idx, {
        multi: true,
        onActivate: function (btn) {
          selected[idx] = !selected[idx];
          setRowSelected(btn, selected[idx]);
          var any = Object.keys(selected).some(function (k) { return selected[k]; });
          continueBtn.disabled = !any;
        }
      });
      wrap.appendChild(row);
    });
    var continueBtn = continueButton('Continue', function () {
      var chosen = Object.keys(selected).filter(function (k) { return selected[k]; }).map(Number);
      cfg.onContinue(chosen);
    });
    if (cfg.backTo) root.appendChild(backButton());
    root.appendChild(heading(cfg.heading));
    root.appendChild(wrap);
    root.appendChild(continueBtn);
  }

  // ── Single-select screens (3, 5, 7, entry): tapping a row advances
  // immediately -- same one-tap convention start.html's own arm A/B role
  // rows already use, and the fastest path on the mobile rail this arm
  // has to cover (78% mobile). ──
  function renderSingleSelect(cfg) {
    var wrap = optionsWrap();
    cfg.options.forEach(function (option, i) {
      var idx = i + 1;
      var label = typeof option === 'string' ? option : option.label;
      var disabled = typeof option === 'object' && option.disabled;
      var row = optionRow(label, idx, {
        disabled: disabled,
        onActivate: function () { cfg.onSelect(idx); }
      });
      wrap.appendChild(row);
    });
    if (cfg.backTo) root.appendChild(backButton());
    root.appendChild(heading(cfg.heading));
    if (cfg.sub) root.appendChild(bodyText(cfg.sub));
    root.appendChild(wrap);
  }

  // ── Disqualifier screens (4, 5, 6, 7's dq siblings): the same large
  // tappable rows as every qualifying screen -- never a modal, never
  // confirm(), which traps focus in the Facebook in-app webview (this
  // arm's single worst mobile failure mode). ──
  function renderDisqualifier(cfg) {
    var textEl = bodyText(cfg.text);
    root.appendChild(textEl);
    var wrap = optionsWrap();
    var opt1 = optionRow(cfg.opt1, 1, { onActivate: function () { cfg.onContinue(); } });
    wrap.appendChild(opt1);
    root.appendChild(wrap);
  }

  // ── Contact screen (8): same field set/shape as the existing homeowner
  // flow's Step 1 (name, email, phone) -- reusing bridge.insertFreshLead's
  // exact signature, just with this module's own DOM ids (rd*) so it never
  // collides with the hidden #step1 form's ids elsewhere in the document. ──
  function normalizePhone(raw) {
    var digits = (raw || '').replace(/\D/g, '');
    if (digits.length === 11 && digits.charAt(0) === '1') digits = digits.slice(1);
    return digits;
  }
  function isValidUsPhone(raw) {
    var digits = normalizePhone(raw);
    if (digits.length !== 10) return false;
    if (/^(\d)\1{9}$/.test(digits)) return false;
    if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return false;
    return true;
  }

  function renderContact() {
    root.appendChild(bodyText(COPY.home8Text));

    function field(id, labelText, type, extra) {
      var group = el('div', 'form-group');
      var label = el('label', 'form-label required', labelText);
      label.setAttribute('for', id);
      var input = el('input', 'form-input');
      input.type = type;
      input.id = id;
      if (extra) {
        Object.keys(extra).forEach(function (k) { input.setAttribute(k, extra[k]); });
      }
      var err = el('div', 'field-error');
      err.id = id + 'Error';
      group.appendChild(label);
      group.appendChild(input);
      group.appendChild(err);
      root.appendChild(group);
      return { input: input, err: err };
    }

    var nameF = field('rdName', 'Full Name', 'text', { autocomplete: 'name', maxlength: '200' });
    var emailF = field('rdEmail', 'Email', 'email', { autocomplete: 'email', inputmode: 'email', maxlength: '320' });
    var phoneF = field('rdPhone', 'Phone Number (optional)', 'tel', { autocomplete: 'tel', inputmode: 'tel', maxlength: '20' });
      // gh-2042: phone is optional -- drop the `required` label marker the
      // shared field() helper applies to every field.
      phoneF.input.parentNode.querySelector('.form-label').classList.remove('required');


    var submitBtn = el('button', 'btn btn-primary router-btn', 'Continue');
    submitBtn.type = 'button';
    submitBtn.id = 'rdContactSubmit';
    root.appendChild(submitBtn);

    submitBtn.addEventListener('click', function () {
      nameF.err.textContent = '';
      emailF.err.textContent = '';
      phoneF.err.textContent = '';

      var name = nameF.input.value.trim();
      var email = emailF.input.value.trim();
      var phoneRaw = phoneF.input.value.trim();

      var hasError = false;
      if (!name) { nameF.err.textContent = 'Please enter your name.'; hasError = true; }
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { emailF.err.textContent = 'Please enter a valid email address.'; hasError = true; }
      if (phoneRaw && !isValidUsPhone(phoneRaw)) { phoneF.err.textContent = 'Please enter a valid 10-digit US phone number.'; hasError = true; }
      if (hasError) return;

      if (!bridge.sb) { bridge.showError('Something went wrong loading the form. Please refresh and try again.'); return; }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Please wait…';

      var phoneDigits = phoneRaw ? normalizePhone(phoneRaw) : null; // gh-2042

      bridge.insertFreshLead(name, email, phoneDigits).then(function (newId) {
        // gh-2017: leads_force_safe_insert_defaults() forces role NULL on
        // every raw insert regardless of arm, so this RPC is mandatory
        // here exactly as it is on arms A/B -- not extra work this arm
        // avoids. Same payload shape as start.html's own set_lead_role
        // call sites (p_lead_id/p_role). Never rejects the flow forward --
        // a failed role write must not strand a visitor on the router,
        // same rule arms A/B already follow.
        function proceed() {
          emitComplete('c-home-8');
          // gh-2075 round 2, review report ceo57-review-pr2086-20260921
          // finding 5 (non-blocking on #2075 itself, but biases any D-vs-C
          // read): this used to call bridge.redirectTo(...) with
          // preBuilt=!!NO_LEAD_ID_DESTINATIONS.homeowner -- that map is
          // EMPTY (gh-2046 emptied it once homeowners started getting
          // ?lead=<uuid> like every other destination), so preBuilt was
          // always false, which made redirectTo() append `lead=` from
          // start.html's own top-level `leadId` var -- a var this module
          // NEVER sets (every other call site in this file passes
          // preBuilt=true for exactly this reason; this was the one call
          // site that did not) -- producing a literal `lead=null` AND a
          // second, duplicate round of attribution params (redirectTo's
          // own non-preBuilt branch re-appends collectAttribution() on
          // top of the appendParams() call already made above). C
          // homeowners got no #2046 prefill; D's own equivalent hand-off
          // (js/router-variant-d.js) does not have this bug, which biases
          // a D-vs-C comparison in D's favour. redirectWithLeadId is the
          // same helper every other track in this file already uses.
          redirectWithLeadId(bridge.ROLE_DESTINATIONS.homeowner, newId);
        }
        bridge.sb.rpc('set_lead_role', { p_lead_id: newId, p_role: 'homeowner' }).then(proceed).catch(function (roleErr) {
          console.error('[router-discovery] set_lead_role failed -- proceeding to destination anyway:', roleErr);
          proceed();
        });
      }).catch(function (err) {
        console.error('[router-discovery] contact save failed:', err);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Continue';
        bridge.showError('Something went wrong saving your info. Please try again.');
      });
    });
  }

  // ── Screen registry ──
  RENDERERS['c-entry'] = function () {
    renderSingleSelect({
      heading: COPY.entryIntro,
      options: [
        { label: COPY.entryOptions[0], disabled: false },
        // gh-2018: options 2 (professional) and 3 (contractor) are now
        // wired -- the professional row leads to the industry picker
        // (c-prof-entry), the contractor row leads straight into the
        // contractor track, since it has exactly one destination and no
        // industry branch.
        { label: COPY.entryOptions[1], disabled: false },
        { label: COPY.entryOptions[2], disabled: false }
      ],
      onSelect: function (idx) {
        if (idx === 1) { go('c-home-1'); return; }
        if (idx === 2) { go('c-prof-entry'); return; }
        go('c-contractor-1');
      }
    });
  };

  RENDERERS['c-home-1'] = function () {
    root.appendChild(bodyText(COPY.home1));
    // Starts enabled -- this screen asks no question, so there is nothing
    // to gate it on (unlike the multi-select Continue buttons below).
    root.appendChild(continueButton('Continue', function () { go('c-home-2'); }, true));
  };

  RENDERERS['c-home-2'] = function () {
    renderMultiSelect({
      heading: COPY.home2Heading,
      options: COPY.home2Options,
      backTo: true,
      onContinue: function (chosen) {
        answers.trades = chosen.map(function (i) { return COPY.home2Options[i - 1]; });
        go('c-home-3');
      }
    });
  };

  RENDERERS['c-home-3'] = function () {
    renderSingleSelect({
      heading: COPY.home3Heading,
      options: COPY.home3Options,
      backTo: true,
      onSelect: function (idx) {
        answers.payer = COPY.home3Options[idx - 1];
        go('c-home-4');
      }
    });
  };

  RENDERERS['c-home-4'] = function () {
    renderMultiSelect({
      heading: COPY.home4Heading,
      options: COPY.home4Options,
      backTo: true,
      onContinue: function (chosen) {
        answers.hiddenCosts = chosen;
        // Qualifies only when the selection is EXACTLY {5} ("None of the
        // above") and nothing else -- "fires on anything but option 5"
        // read against a multi-select: any of 1-4 present, alone or
        // alongside 5, disqualifies.
        var qualifies = chosen.length === 1 && chosen[0] === 5;
        if (qualifies) { go('c-home-5'); } else { go('c-home-dq-4'); }
      }
    });
  };

  RENDERERS['c-home-dq-4'] = function () {
    renderDisqualifier({
      text: COPY.dq4Text,
      opt1: COPY.dq4Opt1,
      onContinue: function () { go('c-home-5'); }
    });
  };

  RENDERERS['c-home-5'] = function () {
    renderSingleSelect({
      heading: COPY.home5Heading,
      options: COPY.home5Options,
      backTo: true,
      onSelect: function (idx) {
        answers.timeInvestment = COPY.home5Options[idx - 1];
        if (idx === 3) { go('c-home-dq-5'); } else { go('c-home-6'); }
      }
    });
  };

  RENDERERS['c-home-dq-5'] = function () {
    renderDisqualifier({
      text: COPY.dq5Text,
      opt1: COPY.dq5Opt1,
      onContinue: function () { go('c-home-6'); }
    });
  };

  RENDERERS['c-home-6'] = function () {
    renderMultiSelect({
      heading: COPY.home6Heading,
      options: COPY.home6Options,
      backTo: true,
      onContinue: function (chosen) {
        answers.selectionCriteria = chosen;
        var disqualifyingChoice = chosen.some(function (n) { return n === 6 || n === 7 || n === 8; });
        if (disqualifyingChoice) { go('c-home-dq-6'); } else { go('c-home-7'); }
      }
    });
  };

  RENDERERS['c-home-dq-6'] = function () {
    renderDisqualifier({
      text: COPY.dq6Text,
      opt1: COPY.dq6Opt1,
      onContinue: function () { go('c-home-7'); }
    });
  };

  RENDERERS['c-home-7'] = function () {
    renderSingleSelect({
      heading: COPY.home7Heading,
      options: COPY.home7Options,
      backTo: true,
      onSelect: function (idx) {
        answers.online = COPY.home7Options[idx - 1];
        // D-2, ruled: option 1 disqualifies, option 2 QUALIFIES and
        // continues to c-home-8. This is the single highest-risk line in
        // this build -- see the D-2 control in this PR's evidence.
        if (idx === 1) { go('c-home-dq-7'); } else { go('c-home-8'); }
      }
    });
  };

  RENDERERS['c-home-dq-7'] = function () {
    renderDisqualifier({
      text: COPY.dq7Text,
      opt1: COPY.dq7Opt1,
      onContinue: function () { go('c-home-8'); }
    });
  };

  RENDERERS['c-home-8'] = renderContact;

  // ── gh-2018: professional / contractor tracks ──

  // Arm C never lets start.html's own module-level `leadId` get set (every
  // call site above passes preBuilt=true to bridge.redirectTo for exactly
  // this reason -- see renderContact's own comment), so the lead id these
  // tracks obtain from their own insertFreshLead() call has to be appended
  // by hand rather than relying on redirectTo's internal auto-append.
  // Mirrors what that internal branch does for a role that is NOT in
  // NO_LEAD_ID_DESTINATIONS (contractor/referral_partner both qualify --
  // only homeowner is in that map): ?lead=<uuid> plus attribution.
  function redirectWithLeadId(destBase, newLeadId) {
    var sep = destBase.indexOf('?') === -1 ? '?' : '&';
    var withLead = destBase + sep + 'lead=' + encodeURIComponent(newLeadId);
    bridge.redirectTo(bridge.appendParams(withLead, bridge.collectAttribution()), true);
  }

  RENDERERS['c-prof-entry'] = function () {
    // gh-2018: options sourced from window.AgentTypes.CHOOSER_LABELS
    // (js/agent-types.js, already loaded by start.html before this module
    // runs) -- never a local label map. Order matches start.html's own
    // PARTNER_INDUSTRY_ORDER.
    var order = ['re_agent', 'insurance_agent', 'home_inspector', 'adjuster', 'other'];
    var labels = (window.AgentTypes && window.AgentTypes.CHOOSER_LABELS) || {};
    renderSingleSelect({
      heading: COPY.profEntryHeading,
      sub: COPY.profEntrySub,
      backTo: true,
      options: order.map(function (code) { return labels[code] || code; }),
      onSelect: function (idx) {
        var industry = order[idx - 1];
        answers.partnerIndustry = industry;
        if (industry === 're_agent') { go('c-realtor-1'); return; }
        if (industry === 'insurance_agent') { go('c-ins-1'); return; }
        // home_inspector (DEFERRED -- #2018: "no copy exists... do not
        // invent it"), adjuster and other (#2018: "no track is specified")
        // all fall through here, so no professional is ever dead-ended.
        // This module has not captured contact yet at this point (unlike
        // arm A/B, where Step 2a is only reached after Step 1's contact
        // capture already created the lead row) -- there is no lead id to
        // attach a role to. Rather than guess a step token this issue does
        // not define, or fabricate a placeholder email just to call
        // set_lead_role early, this sends the visitor straight to the same
        // destination page arm A/B would (attribution only, no lead id) --
        // that page owns its own signup capture, same as a visitor who
        // navigated there directly. Flagged as a QUESTION in this PR.
        emitComplete('c-prof-entry');
        var dest = bridge.PARTNER_INDUSTRY_DESTINATIONS[industry];
        bridge.redirectTo(bridge.appendParams(dest, bridge.collectAttribution()), true);
      }
    });
  };

  // ── Shared contact-capture screen for the three tracks below. Same
  // shape as renderContact (name/email/phone, insertFreshLead once, then
  // set_lead_role, never strands the visitor if the role write fails) --
  // its own DOM ids (rdp*) so it cannot collide with renderContact's rd*
  // ids or the hidden #step1 form's ids elsewhere in the document. ──
  function renderPartnerContact(cfg) {
    cfg.introParagraphs.forEach(function (p) { root.appendChild(bodyText(p)); });

    function field(id, labelText, type, extra) {
      var group = el('div', 'form-group');
      var label = el('label', 'form-label required', labelText);
      label.setAttribute('for', id);
      var input = el('input', 'form-input');
      input.type = type;
      input.id = id;
      if (extra) {
        Object.keys(extra).forEach(function (k) { input.setAttribute(k, extra[k]); });
      }
      var err = el('div', 'field-error');
      err.id = id + 'Error';
      group.appendChild(label);
      group.appendChild(input);
      group.appendChild(err);
      root.appendChild(group);
      return { input: input, err: err };
    }

    var nameF = field('rdpName', 'Full Name', 'text', { autocomplete: 'name', maxlength: '200' });
    var emailF = field('rdpEmail', 'Email', 'email', { autocomplete: 'email', inputmode: 'email', maxlength: '320' });
    var phoneF = field('rdpPhone', 'Phone Number (optional)', 'tel', { autocomplete: 'tel', inputmode: 'tel', maxlength: '20' });
      // gh-2042: phone is optional -- drop the `required` label marker the
      // shared field() helper applies to every field.
      phoneF.input.parentNode.querySelector('.form-label').classList.remove('required');


    var submitBtn = el('button', 'btn btn-primary router-btn', 'Continue');
    submitBtn.type = 'button';
    submitBtn.id = 'rdpContactSubmit';
    root.appendChild(submitBtn);

    submitBtn.addEventListener('click', function () {
      nameF.err.textContent = '';
      emailF.err.textContent = '';
      phoneF.err.textContent = '';

      var name = nameF.input.value.trim();
      var email = emailF.input.value.trim();
      var phoneRaw = phoneF.input.value.trim();

      var hasError = false;
      if (!name) { nameF.err.textContent = 'Please enter your name.'; hasError = true; }
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { emailF.err.textContent = 'Please enter a valid email address.'; hasError = true; }
      if (phoneRaw && !isValidUsPhone(phoneRaw)) { phoneF.err.textContent = 'Please enter a valid 10-digit US phone number.'; hasError = true; }
      if (hasError) return;

      if (!bridge.sb) { bridge.showError('Something went wrong loading the form. Please refresh and try again.'); return; }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Please wait…';

      var phoneDigits = phoneRaw ? normalizePhone(phoneRaw) : null; // gh-2042

      // gh-2088 (PR #2088 round 1, item 3): `bridge.oqInternalOverride` is
      // undefined on arm C's own bridge (start.html never sets it there) --
      // this trailing arg is a no-op for every existing arm C call site.
      // It exists only so a bridge that DOES set it (js/router-variant-e.js's
      // own bridge, only while the ?v=e&oq_internal=1 QA override is active)
      // can flag a pre-flip QA walk's lead as synthetic without a schema/RPC
      // change -- see insertFreshLead's own comment in start.html.
      bridge.insertFreshLead(name, email, phoneDigits, bridge.oqInternalOverride).then(function (newId) {
        var payload = { p_lead_id: newId, p_role: cfg.role };
        if (cfg.partnerIndustry) payload.p_partner_industry = cfg.partnerIndustry;

        function proceed() {
          emitComplete(cfg.completeToken);
          redirectWithLeadId(cfg.destination, newId);
        }
        bridge.sb.rpc('set_lead_role', payload).then(function (res) {
          if (res && res.error) throw res.error;
          proceed();
        }).catch(function (roleErr) {
          console.error('[router-discovery] set_lead_role failed -- proceeding to destination anyway:', roleErr);
          proceed();
        });
      }).catch(function (err) {
        console.error('[router-discovery] contact save failed:', err);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Continue';
        bridge.showError('Something went wrong saving your info. Please try again.');
      });
    });
  }

  // ── REALTOR track ──
  RENDERERS['c-realtor-1'] = function () {
    renderSingleSelect({
      heading: COPY.realtorQ1Heading,
      options: COPY.realtorQ1Options,
      backTo: true,
      onSelect: function (idx) { answers.realtorQ1 = COPY.realtorQ1Options[idx - 1]; go('c-realtor-2'); }
    });
  };
  RENDERERS['c-realtor-2'] = function () {
    renderSingleSelect({
      heading: COPY.realtorQ2Heading,
      options: COPY.realtorQ2Options,
      backTo: true,
      onSelect: function (idx) { answers.realtorQ2 = COPY.realtorQ2Options[idx - 1]; go('c-realtor-3'); }
    });
  };
  RENDERERS['c-realtor-3'] = function () {
    renderSingleSelect({
      heading: COPY.realtorQ3Heading,
      options: COPY.realtorQ3Options,
      backTo: true,
      onSelect: function (idx) { answers.realtorQ3 = COPY.realtorQ3Options[idx - 1]; go('c-realtor-4'); }
    });
  };
  RENDERERS['c-realtor-4'] = function () {
    renderSingleSelect({
      heading: COPY.realtorQ4Heading,
      options: COPY.realtorQ4Options,
      backTo: true,
      onSelect: function (idx) { answers.realtorQ4 = COPY.realtorQ4Options[idx - 1]; go('c-realtor-close'); }
    });
  };
  RENDERERS['c-realtor-close'] = function () {
    COPY.realtorClose.forEach(function (p) { root.appendChild(bodyText(p)); });
    root.appendChild(continueButton('Continue', function () { go('c-realtor-contact'); }, true));
  };
  RENDERERS['c-realtor-contact'] = function () {
    renderPartnerContact({
      introParagraphs: [],
      role: 'referral_partner',
      partnerIndustry: 're_agent',
      destination: bridge.PARTNER_INDUSTRY_DESTINATIONS.re_agent,
      completeToken: 'c-realtor-contact'
    });
  };

  // ── INSURANCE track ──
  RENDERERS['c-ins-1'] = function () {
    renderSingleSelect({
      heading: COPY.insQ1Heading,
      options: COPY.insQ1Options,
      backTo: true,
      onSelect: function (idx) { answers.insQ1 = COPY.insQ1Options[idx - 1]; go('c-ins-2'); }
    });
  };
  RENDERERS['c-ins-2'] = function () {
    renderSingleSelect({
      heading: COPY.insQ2Heading,
      options: COPY.insQ2Options,
      backTo: true,
      // D-5, ruled: this question only asks. No screen anywhere in this
      // build confirms, corrects, scores or reveals the answer -- the flow
      // simply advances.
      onSelect: function (idx) { answers.insQ2 = COPY.insQ2Options[idx - 1]; go('c-ins-3'); }
    });
  };
  RENDERERS['c-ins-3'] = function () {
    renderSingleSelect({
      heading: COPY.insQ3Heading,
      options: COPY.insQ3Options,
      backTo: true,
      onSelect: function (idx) { answers.insQ3 = COPY.insQ3Options[idx - 1]; go('c-ins-4'); }
    });
  };
  RENDERERS['c-ins-4'] = function () {
    renderSingleSelect({
      heading: COPY.insQ4Heading,
      options: COPY.insQ4Options,
      backTo: true,
      onSelect: function (idx) { answers.insQ4 = COPY.insQ4Options[idx - 1]; go('c-ins-5'); }
    });
  };
  RENDERERS['c-ins-5'] = function () {
    renderSingleSelect({
      heading: COPY.insQ5Heading,
      options: COPY.insQ5Options,
      backTo: true,
      onSelect: function (idx) { answers.insQ5 = COPY.insQ5Options[idx - 1]; go('c-ins-6'); }
    });
  };
  RENDERERS['c-ins-6'] = function () {
    renderSingleSelect({
      heading: COPY.insQ6Heading,
      options: COPY.insQ6Options,
      backTo: true,
      onSelect: function (idx) { answers.insQ6 = COPY.insQ6Options[idx - 1]; go('c-ins-7'); }
    });
  };
  RENDERERS['c-ins-7'] = function () {
    renderSingleSelect({
      heading: COPY.insQ7Heading,
      options: COPY.insQ7Options,
      backTo: true,
      onSelect: function (idx) { answers.insQ7 = COPY.insQ7Options[idx - 1]; go('c-ins-close'); }
    });
  };
  RENDERERS['c-ins-close'] = function () {
    COPY.insClose.forEach(function (p) { root.appendChild(bodyText(p)); });
    root.appendChild(continueButton('Continue', function () { go('c-ins-contact'); }, true));
  };
  RENDERERS['c-ins-contact'] = function () {
    renderPartnerContact({
      introParagraphs: [],
      role: 'referral_partner',
      partnerIndustry: 'insurance_agent',
      destination: bridge.PARTNER_INDUSTRY_DESTINATIONS.insurance_agent,
      completeToken: 'c-ins-contact'
    });
  };

  // ── CONTRACTOR track. D-266 is NOT required -- a contractor is not a
  // referral partner. ──
  RENDERERS['c-contractor-1'] = function () {
    renderSingleSelect({
      heading: COPY.contractorQ1Heading,
      options: COPY.contractorQ1Options,
      backTo: true,
      onSelect: function (idx) { answers.contractorQ1 = COPY.contractorQ1Options[idx - 1]; go('c-contractor-2'); }
    });
  };
  RENDERERS['c-contractor-2'] = function () {
    renderSingleSelect({
      heading: COPY.contractorQ2Heading,
      options: COPY.contractorQ2Options,
      backTo: true,
      onSelect: function (idx) { answers.contractorQ2 = COPY.contractorQ2Options[idx - 1]; go('c-contractor-3'); }
    });
  };
  RENDERERS['c-contractor-3'] = function () {
    renderSingleSelect({
      heading: COPY.contractorQ3Heading,
      options: COPY.contractorQ3Options,
      backTo: true,
      onSelect: function (idx) { answers.contractorQ3 = COPY.contractorQ3Options[idx - 1]; go('c-contractor-4'); }
    });
  };
  RENDERERS['c-contractor-4'] = function () {
    renderSingleSelect({
      heading: COPY.contractorQ4Heading,
      options: COPY.contractorQ4Options,
      backTo: true,
      onSelect: function (idx) { answers.contractorQ4 = COPY.contractorQ4Options[idx - 1]; go('c-contractor-5'); }
    });
  };
  RENDERERS['c-contractor-5'] = function () {
    root.appendChild(bodyText(COPY.contractorQ5Text));
    root.appendChild(continueButton('Continue', function () { go('c-contractor-contact'); }, true));
  };
  RENDERERS['c-contractor-contact'] = function () {
    renderPartnerContact({
      introParagraphs: [],
      role: 'contractor',
      partnerIndustry: null,
      destination: bridge.ROLE_DESTINATIONS.contractor,
      completeToken: 'c-contractor-contact'
    });
  };

  function init(injectedBridge, mountEl) {
    bridge = injectedBridge;
    root = mountEl || document.getElementById('routerCRoot');
    if (!root) { return; }
    root.setAttribute('data-rd-root', '1');
    show('c-entry');
  }

  // gh-2075 (D-327): Variant D reuses this module's exact copy and its
  // exact multi-select/single-select/disqualifier rendering for the
  // post-email question screens ("reuse C's step components and copy
  // verbatim -- no new copy in D", issue #2075). js/router-variant-d.js
  // is the only other file allowed to read these exports. renderMultiSelect/
  // renderSingleSelect/renderDisqualifier below are thin wrappers around
  // this module's own functions of the same name: those functions read
  // and write the single module-level `root` closure variable, so each
  // wrapper points `root` at the CALLER's mount element for the duration
  // of the call (synchronous -- these functions never yield control before
  // they finish building DOM) and restores this module's own `root`
  // afterward. Safe because C and D never run in the same page load
  // (`variant` is one value) and neither module's `init()` needs to have
  // run for the other's exports to work. `cfg.backTo` is deliberately NOT
  // forwarded by variant D -- that flag makes these functions call this
  // module's OWN backButton()/goBack(), bound to c-entry's stack, not
  // D's; D prepends its own back button before calling these wrappers
  // instead. COPY/heading/bodyText/continueButton are pure (no `root`
  // read) and exported directly.
  // gh-2088 (PR #2088 round 1, item 6): lets a caller module (js/router-
  // variant-e.js) point this module's own `bridge` at ITS bridge object,
  // so the exported renderPartnerContact/track renderers below -- which
  // read `bridge` internally, the same as every one of arm C's own
  // screens does -- work without that caller ever invoking this module's
  // own init() (which would also call show('c-entry') and render arm C's
  // own screens into whatever root was passed). Arm C itself never calls
  // this -- its own init() sets `bridge` directly, unchanged.
  function setBridge(injectedBridge) { bridge = injectedBridge; }

  function withRoot(targetRoot, fn) {
    var savedRoot = root;
    root = targetRoot;
    try { fn(); } finally { root = savedRoot; }
  }

  window.RouterDiscovery = {
    init: init,
    setBridge: setBridge,
    COPY: COPY,
    PARTNER_INDUSTRY_ORDER: PARTNER_INDUSTRY_ORDER,
    REALTOR_TRACK: REALTOR_TRACK,
    INSURANCE_TRACK: INSURANCE_TRACK,
    CONTRACTOR_TRACK: CONTRACTOR_TRACK,
    heading: heading,
    bodyText: bodyText,
    continueButton: continueButton,
    renderMultiSelect: function (targetRoot, cfg) { withRoot(targetRoot, function () { renderMultiSelect(cfg); }); },
    renderSingleSelect: function (targetRoot, cfg) { withRoot(targetRoot, function () { renderSingleSelect(cfg); }); },
    renderDisqualifier: function (targetRoot, cfg) { withRoot(targetRoot, function () { renderDisqualifier(cfg); }); },
    // gh-2088 (PR #2088 round 1, item 6): exports arm C's own
    // renderPartnerContact (name/email/phone capture + insertFreshLead +
    // set_lead_role + redirect) so js/router-variant-e.js's professional/
    // contractor tracks consume this one implementation instead of a
    // forked copy of it. Same withRoot wrapper as the three renderers
    // above -- see that function's own comment for why it is safe.
    renderPartnerContact: function (targetRoot, cfg) { withRoot(targetRoot, function () { renderPartnerContact(cfg); }); }
  };
})();
