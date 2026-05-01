// Decommissioned temporary E2E helper — disabled April 29, 2026.
// This function was used for E2E testing only and has been stubbed out.
Deno.serve(() => new Response(JSON.stringify({ error: "Decommissioned" }), { status: 410, headers: { "Content-Type": "application/json" } }));
