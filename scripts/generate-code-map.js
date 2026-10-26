#!/usr/bin/env node
/**
 * generate-code-map.js
 * OtterQuote code-map generator — scans HTML pages and their externally referenced
 * JS files to produce a complete edge-function reference map.
 *
 * Outputs (always inside the repo, regardless of cwd):
 *   <repo>/docs/code-map.json   — machine-readable map
 *   <repo>/docs/code-map.md     — human-readable summary
 *
 * Usage: node scripts/generate-code-map.js [--repo-root <path>] [--docs-dir <path>]
 *        SUPABASE_MGMT_TOKEN=<sbp_...> SUPABASE_PROJECT_REF=<ref> node scripts/generate-code-map.js
 *
 * Fix (86e1fwe5r): Column-level schema tracking via Supabase Management API.
 *   Set SUPABASE_MGMT_TOKEN and SUPABASE_PROJECT_REF env vars to enable.
 *   Falls back to table-only mode when credentials are absent.
 *
 * Enhancement (86e1g1vv0): pg_cron + Database Webhook caller tracking.
 *   When SUPABASE_MGMT_TOKEN and SUPABASE_PROJECT_REF are set, also queries:
 *   - cron.job for scheduled EF callers (cron_callers per EF)
 *   - supabase_functions.hooks for database webhook callers (webhook_callers per EF)
 *   Populates edge_functions section with per-EF caller inventory.
 *   EFs with cron or webhook callers are NOT flagged as orphans.
 *
 * EF call patterns detected:
 *   1. fetch(...) calls:     /functions/v1/<ef-name>
 *   2. invoke calls:         supabase.functions.invoke('<ef-name>')
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const args      = process.argv.slice(2);
const rootIdx   = args.indexOf('--repo-root');
const docsIdx   = args.indexOf('--docs-dir');
const REPO_ROOT = rootIdx !== -1 ? args[rootIdx + 1] : path.resolve(__dirname, '..');
const DOCS_DIR  = docsIdx !== -1 ? args[docsIdx + 1] : path.resolve(REPO_ROOT, 'docs');

const TODAY = new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// EF name extraction patterns
// ---------------------------------------------------------------------------
const EF_PATTERNS = [
  // fetch('/functions/v1/ef-name'  or  fetch(`...functions/v1/ef-name`...)
  /\/functions\/v1\/([a-z0-9][a-z0-9_-]*[a-z0-9])/g,
  // supabase.functions.invoke('ef-name') or invoke("ef-name")
  /supabase\.functions\.invoke\(['"]([a-z0-9][a-z0-9_-]*[a-z0-9])['"]/g,
];

/**
 * Extract all EF names referenced in a block of text.
 * Returns a de-duplicated sorted array.
 */
function extractEfNames(text) {
  const found = new Set();
  for (const pattern of EF_PATTERNS) {
    pattern.lastIndex = 0; // reset stateful regex
    let m;
    while ((m = pattern.exec(text)) !== null) {
      found.add(m[1]);
    }
  }
  return [...found].sort();
}

// ---------------------------------------------------------------------------
// Script / stylesheet extraction from HTML
// ---------------------------------------------------------------------------
const SCRIPT_SRC_RE    = /<script[^>]+\bsrc=["']([^"']+)["'][^>]*>/gi;
const INLINE_SCRIPT_RE = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
const STYLESHEET_RE    = /<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["'][^>]*>|<link[^>]+href=["']([^"']+)["'][^>]+rel=["']stylesheet["'][^>]*>/gi;

function parseHtml(html) {
  const scripts     = [];
  const stylesheets = [];

  // External script sources
  let m;
  SCRIPT_SRC_RE.lastIndex = 0;
  while ((m = SCRIPT_SRC_RE.exec(html)) !== null) {
    scripts.push(m[1]);
  }

  // Stylesheets
  STYLESHEET_RE.lastIndex = 0;
  while ((m = STYLESHEET_RE.exec(html)) !== null) {
    stylesheets.push(m[1] || m[2]);
  }

  // Inline EF refs (from <script> blocks without src)
  const inlineEfRefs = [];
  INLINE_SCRIPT_RE.lastIndex = 0;
  while ((m = INLINE_SCRIPT_RE.exec(html)) !== null) {
    for (const ef of extractEfNames(m[1])) inlineEfRefs.push(ef);
  }

  return { scripts, stylesheets, inlineEfRefs };
}

// ---------------------------------------------------------------------------
// Build per-JS-file EF cache so we only read each file once
// ---------------------------------------------------------------------------
function buildJsEfCache(jsDir) {
  const cache = {}; // basename → [ef-name, ...]
  if (!fs.existsSync(jsDir)) return cache;
  for (const file of fs.readdirSync(jsDir)) {
    if (!file.endsWith('.js')) continue;
    try {
      const src = fs.readFileSync(path.join(jsDir, file), 'utf8');
      cache[file] = extractEfNames(src);
    } catch (_) {
      cache[file] = [];
    }
  }
  return cache;
}

// ---------------------------------------------------------------------------
// Supabase Management API helper
// ---------------------------------------------------------------------------
async function supabaseQuery(query) {
  const mgmtToken  = process.env.SUPABASE_MGMT_TOKEN;
  const projectRef = process.env.SUPABASE_PROJECT_REF;
  if (!mgmtToken || !projectRef) return null;

  const url = `https://api.supabase.com/v1/projects/${projectRef}/database/query`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${mgmtToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    });
  } catch (err) {
    return { error: err.message };
  }

  if (!res.ok) {
    return { error: `API ${res.status}: ${await res.text()}` };
  }
  return { rows: await res.json() };
}

// ---------------------------------------------------------------------------
// Supabase column-level schema fetch (86e1fwe5r)
// ---------------------------------------------------------------------------
/**
 * Fetch column metadata from Supabase via Management API.
 * Returns { tableName: [{ column, type, nullable }] } or null on failure.
 */
async function fetchColumnMetadata() {
  const result = await supabaseQuery(
    `SELECT table_name, column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public'
     ORDER BY table_name, ordinal_position`
  );
  if (!result || result.error) {
    if (result) console.warn(`[column-metadata] ${result.error}`);
    return null;
  }

  const tableMap = {};
  for (const row of result.rows) {
    if (!tableMap[row.table_name]) tableMap[row.table_name] = [];
    tableMap[row.table_name].push({
      column:   row.column_name,
      type:     row.data_type,
      nullable: row.is_nullable === 'YES',
    });
  }
  return tableMap;
}

// ---------------------------------------------------------------------------
// pg_cron caller fetch (86e1g1vv0)
// ---------------------------------------------------------------------------
/**
 * Query cron.job and return a map of { efName: [{ jobname, schedule }] }.
 * EF names are extracted from the cron command string using the same
 * /functions/v1/<ef-name> pattern as the page scanner.
 * Returns null when credentials are absent.
 */
async function fetchCronCallers() {
  const result = await supabaseQuery(`SELECT jobname, schedule, command FROM cron.job`);
  if (!result) return null; // no credentials
  if (result.error) {
    console.warn(`[cron-callers] ${result.error} — skipping pg_cron tracking`);
    return null;
  }

  const cronCallers = {}; // efName -> [{ jobname, schedule }]
  for (const row of result.rows) {
    const efNames = extractEfNames(row.command || '');
    for (const ef of efNames) {
      if (!cronCallers[ef]) cronCallers[ef] = [];
      cronCallers[ef].push({ jobname: row.jobname, schedule: row.schedule });
    }
  }
  return cronCallers;
}

// ---------------------------------------------------------------------------
// Database Webhook caller fetch (86e1g1vv0)
// ---------------------------------------------------------------------------
/**
 * Query supabase_functions.hooks and return { efName: [{ hook_name, hook_table_id, hook_events }] }.
 * EF name is extracted from the request_path column (e.g. /functions/v1/ef-name).
 * Returns null when credentials are absent or the table doesn't exist.
 */
async function fetchWebhookCallers() {
  const result = await supabaseQuery(
    `SELECT hook_name, hook_table_id, hook_events, request_path
     FROM supabase_functions.hooks`
  );
  if (!result) return null; // no credentials
  if (result.error) {
    // supabase_functions.hooks may not exist in all project tiers
    console.warn(`[webhook-callers] ${result.error} — skipping database webhook tracking`);
    return null;
  }

  const webhookCallers = {}; // efName -> [{ hook_name, hook_table_id, hook_events }]
  for (const row of result.rows) {
    const match = row.request_path &&
      row.request_path.match(/\/functions\/v1\/([a-z0-9][a-z0-9_-]*[a-z0-9])/);
    if (!match) continue;
    const efName = match[1];
    if (!webhookCallers[efName]) webhookCallers[efName] = [];
    webhookCallers[efName].push({
      hook_name:     row.hook_name,
      hook_table_id: row.hook_table_id,
      hook_events:   row.hook_events,
    });
  }
  return webhookCallers;
}

// ---------------------------------------------------------------------------
// Build edge_functions section (86e1g1vv0)
// ---------------------------------------------------------------------------
/**
 * Build a per-EF caller inventory that inverts the page→EF mapping and
 * merges in cron and webhook callers.
 *
 * An EF is only flagged is_orphan=true if it has ZERO callers across all
 * three sources (pages, cron, webhooks).
 *
 * @param {Object} pages          — { htmlFile: { edge_function_refs: [ef] } }
 * @param {string} efFunctionsDir — path to supabase/functions/ directory
 * @param {Object|null} cronCallers    — from fetchCronCallers()
 * @param {Object|null} webhookCallers — from fetchWebhookCallers()
 * @returns {Object} efMap
 */
function buildEdgeFunctionsMap(pages, efFunctionsDir, cronCallers, webhookCallers) {
  const efMap = {}; // efName -> { page_callers, cron_callers, webhook_callers, is_orphan, total_callers }

  const ensureEf = (name) => {
    if (!efMap[name]) efMap[name] = { page_callers: [], cron_callers: [], webhook_callers: [] };
  };

  // Invert page→EF into EF→pages
  for (const [htmlFile, data] of Object.entries(pages)) {
    for (const ef of data.edge_function_refs) {
      ensureEf(ef);
      efMap[ef].page_callers.push(htmlFile);
    }
  }

  // Merge cron callers
  if (cronCallers) {
    for (const [ef, jobs] of Object.entries(cronCallers)) {
      ensureEf(ef);
      efMap[ef].cron_callers = jobs;
    }
  }

  // Merge webhook callers
  if (webhookCallers) {
    for (const [ef, hooks] of Object.entries(webhookCallers)) {
      ensureEf(ef);
      efMap[ef].webhook_callers = hooks;
    }
  }

  // Seed all deployed EFs (even those with zero callers)
  if (fs.existsSync(efFunctionsDir)) {
    for (const dir of fs.readdirSync(efFunctionsDir)) {
      if (!fs.statSync(path.join(efFunctionsDir, dir)).isDirectory()) continue;
      ensureEf(dir);
    }
  }

  // Compute is_orphan and total_callers
  for (const [, data] of Object.entries(efMap)) {
    data.total_callers = data.page_callers.length + data.cron_callers.length + data.webhook_callers.length;
    data.is_orphan     = data.total_callers === 0;
  }

  return efMap;
}

// ---------------------------------------------------------------------------
// Main scan
// ---------------------------------------------------------------------------
async function run() {
  // Fetch column-level schema data when credentials are available
  const columnSchema = await fetchColumnMetadata();
  if (columnSchema) {
    console.log(`✓ column-level schema fetched for ${Object.keys(columnSchema).length} tables`);
  } else {
    console.log('  column-level schema: skipped (set SUPABASE_MGMT_TOKEN + SUPABASE_PROJECT_REF to enable)');
  }

  // Fetch pg_cron callers (86e1g1vv0)
  const cronCallers = await fetchCronCallers();
  if (cronCallers) {
    const efCount = Object.keys(cronCallers).length;
    console.log(`✓ pg_cron callers fetched: ${efCount} EF(s) called via cron`);
  } else {
    console.log('  pg_cron callers: skipped (set SUPABASE_MGMT_TOKEN + SUPABASE_PROJECT_REF to enable)');
  }

  // Fetch database webhook callers (86e1g1vv0)
  const webhookCallers = await fetchWebhookCallers();
  if (webhookCallers) {
    const efCount = Object.keys(webhookCallers).length;
    console.log(`✓ database webhook callers fetched: ${efCount} EF(s) called via webhook`);
  } else {
    console.log('  database webhook callers: skipped (set SUPABASE_MGMT_TOKEN + SUPABASE_PROJECT_REF to enable)');
  }

  const jsDir  = path.join(REPO_ROOT, 'js');
  const jsCache = buildJsEfCache(jsDir);

  const htmlFiles = fs.readdirSync(REPO_ROOT)
    .filter(f => f.endsWith('.html'))
    .sort();

  const pages = {};
  let totalPageToEf = 0;

  for (const htmlFile of htmlFiles) {
    const html = fs.readFileSync(path.join(REPO_ROOT, htmlFile), 'utf8');
    const { scripts, stylesheets, inlineEfRefs } = parseHtml(html);

    // Collect EF refs from inline blocks
    const efSet = new Set(inlineEfRefs);

    // --- FIX 86e1ewyvh: also scan external js/*.js files ---
    for (const src of scripts) {
      // Match paths like js/foo.js or ./js/foo.js
      const jsMatch = src.match(/(?:^|\/)(js\/[a-zA-Z0-9_-]+\.js)$/);
      if (!jsMatch) continue;
      const basename = path.basename(jsMatch[1]);
      if (jsCache[basename]) {
        for (const ef of jsCache[basename]) efSet.add(ef);
      }
    }

    const edge_function_refs = [...efSet].sort();
    totalPageToEf += edge_function_refs.length;

    pages[htmlFile] = { scripts, stylesheets, edge_function_refs };
  }

  // Count distinct EF names referenced from pages (for console output)
  const referencedEfNames = new Set();
  for (const { edge_function_refs } of Object.values(pages)) {
    for (const ef of edge_function_refs) referencedEfNames.add(ef);
  }

  // Count total deployed EFs from supabase/functions directory
  const efFunctionsDir = path.join(REPO_ROOT, 'supabase', 'functions');
  let deployedEfCount = 0;
  if (fs.existsSync(efFunctionsDir)) {
    deployedEfCount = fs.readdirSync(efFunctionsDir)
      .filter(f => fs.statSync(path.join(efFunctionsDir, f)).isDirectory())
      .length;
  }

  // Build edge_functions caller map (86e1g1vv0)
  const efMap = buildEdgeFunctionsMap(pages, efFunctionsDir, cronCallers, webhookCallers);
  const orphanCount = Object.values(efMap).filter(d => d.is_orphan).length;
  const cronEfCount    = cronCallers    ? Object.keys(cronCallers).length    : 0;
  const webhookEfCount = webhookCallers ? Object.keys(webhookCallers).length : 0;

  // Build output
  const tableCount = columnSchema ? Object.keys(columnSchema).length : 46;
  const output = {
    generated_date: TODAY,
    repo: 'otterquote-platform',
    state: 'pre-D-211-static-site',
    summary: {
      pages: htmlFiles.length,
      edge_functions: deployedEfCount || referencedEfNames.size,
      sql_tables: tableCount,
      column_tracking: columnSchema !== null,
      cron_tracking:    cronCallers !== null,
      webhook_tracking: webhookCallers !== null,
      orphan_efs: orphanCount,
      cross_references: {
        page_to_edge_function: totalPageToEf,
        edge_function_to_table: 131, // maintained manually — EF→table refs from supabase/functions
        total: totalPageToEf + 131,
      },
    },
    pages,
    edge_functions: efMap,
    ...(columnSchema && { sql_tables_schema: columnSchema }),
  };

  // Write JSON
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  fs.writeFileSync(path.join(DOCS_DIR, 'code-map.json'), JSON.stringify(output, null, 2), 'utf8');

  // Write Markdown
  const md = buildMarkdown(output);
  fs.writeFileSync(path.join(DOCS_DIR, 'code-map.md'), md, 'utf8');

  const cronMsg    = cronCallers    ? `, ${cronEfCount} EF(s) with cron callers`    : '';
  const webhookMsg = webhookCallers ? `, ${webhookEfCount} EF(s) with webhook callers` : '';
  const columnMsg  = columnSchema   ? `, ${Object.keys(columnSchema).length} tables with column metadata` : '';
  console.log(`✓ code-map generated: ${htmlFiles.length} pages, ${deployedEfCount} deployed EFs, ${referencedEfNames.size} referenced, ${totalPageToEf} page→EF refs${cronMsg}${webhookMsg}, ${orphanCount} orphan EFs${columnMsg}`);
  return output;
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------
function buildMarkdown(output) {
  const { generated_date, repo, state, summary, pages, edge_functions } = output;
  const lines = [
    `# OtterQuote Code Map`,
    ``,
    `**Generated:** ${generated_date}  `,
    `**Repo:** ${repo}  `,
    `**State:** ${state}  `,
    ``,
    `## Summary`,
    ``,
    `| Category | Count |`,
    `|---|---|`,
    `| HTML Pages | ${summary.pages} |`,
    `| Edge Functions | ${summary.edge_functions} |`,
    `| SQL Tables (created) | ${summary.sql_tables} |`,
    `| Orphan EFs (zero callers) | ${summary.orphan_efs} |`,
    `| Cross-refs: page→EF | ${summary.cross_references.page_to_edge_function} |`,
    `| Cross-refs: EF→table | ${summary.cross_references.edge_function_to_table} |`,
    `| Cross-refs total | ${summary.cross_references.total} |`,
    ``,
    `---`,
    ``,
    `## Edge Functions`,
    ``,
    `> EFs with only cron or webhook callers are NOT orphans. ` +
    `Cron tracking: ${summary.cron_tracking ? '✅' : '⚠️ disabled'}. ` +
    `Webhook tracking: ${summary.webhook_tracking ? '✅' : '⚠️ disabled'}.`,
    ``,
    `| EF Name | Page Callers | Cron Callers | Webhook Callers | Orphan? |`,
    `|---|---|---|---|---|`,
  ];

  if (edge_functions) {
    for (const [efName, data] of Object.entries(edge_functions).sort()) {
      lines.push(
        `| \`${efName}\` ` +
        `| ${data.page_callers.length} ` +
        `| ${data.cron_callers.length} ` +
        `| ${data.webhook_callers.length} ` +
        `| ${data.is_orphan ? '⚠️ YES' : '✅ no'} |`
      );
    }
  }

  lines.push(``, `---`, ``, `## HTML Pages`);

  // Count external (CDN) vs local scripts
  for (const [htmlFile, data] of Object.entries(pages)) {
    lines.push(``, `### \`${htmlFile}\``);
    const localScripts  = data.scripts.filter(s => !s.startsWith('http'));
    const externalCount = data.scripts.filter(s => s.startsWith('http')).length;
    if (localScripts.length)  lines.push(`- **Local scripts:** ${localScripts.join(', ')}`);
    if (externalCount)        lines.push(`- **External scripts:** ${externalCount} (Sentry, Supabase JS, GTM, etc.)`);
    if (data.stylesheets.filter(s => !s.startsWith('http')).length) {
      lines.push(`- **Stylesheets:** ${data.stylesheets.filter(s => !s.startsWith('http')).join(', ')}`);
    }
    if (data.edge_function_refs.length) {
      lines.push(`- **Edge functions called:** ${data.edge_function_refs.join(', ')}`);
    }
  }

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
run().catch(err => { console.error('generate-code-map failed:', err); process.exit(1); });
