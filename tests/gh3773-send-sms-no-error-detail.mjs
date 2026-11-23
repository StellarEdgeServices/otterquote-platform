// gh-3773 / code-scanning alert #95 (js/stack-trace-exposure, send-sms/index.ts): the catch block must not put the error
// message into the HTTP response. Static check (no Deno needed). Run: node tests/gh3773-send-sms-no-error-detail.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const root = process.env.ROOT || join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "supabase/functions/send-sms/index.ts"), "utf8");
const i = src.lastIndexOf("} catch (error) {");
if (i < 0) { console.error("FAIL: final catch block not found"); process.exit(1); }
const block = src.slice(i);
const resp = block.slice(block.indexOf("return new Response("));
const fails = [];
if (/JSON\.stringify\(\{\s*error:\s*(safeErr|error)\b/.test(resp)) fails.push("catch response body carries the error message (safeErr/error)");
if (!/JSON\.stringify\(\{\s*error:\s*"SMS send failed"\s*\}\)/.test(resp)) fails.push('catch response body is not the fixed {"error":"SMS send failed"}');
if (!/console\.error\("send-sms error:", safeErr\)/.test(block)) fails.push("masked detail is no longer logged server-side");
if (fails.length) { console.error("FAIL:\n - " + fails.join("\n - ")); process.exit(1); }
console.log("PASS: gh-3773 send-sms 500 body is fixed text; masked detail stays in the server log");
