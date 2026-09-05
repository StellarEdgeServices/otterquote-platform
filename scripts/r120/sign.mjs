#!/usr/bin/env node
// scripts/r120/sign.mjs — CLI counterpart of sign.html for a shell that holds
// the private JWK (e.g. the orchestrator's forgery/positive test with the
// TEST key). Node 20+, no dependencies, no network.
//
//   node scripts/r120/sign.mjs --key /path/private.jwk --pr 1234 --sha <40hex> [--owner X --repo Y]
//   node scripts/r120/sign.mjs --keygen            # prints a fresh keypair as JSON {privateJwk, publicJwk}
//
// The private key is read from the file named by --key (or the R120_PRIVATE_JWK
// env var) and is never printed. Output is the exact comment line to paste on the PR:
//   R-120 SIGNED: pr=<n> sha=<sha> sig=<base64url>

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { approvalMessage, bytesToBase64url } from './verify.mjs';

const subtle = globalThis.crypto.subtle;

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}

async function keygen() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await subtle.exportKey('jwk', kp.privateKey);
  const { kty, crv, x, y } = await subtle.exportKey('jwk', kp.publicKey);
  return { privateJwk, publicJwk: { kty, crv, x, y, use: 'sig', alg: 'ES256', kid: 'r120-review' } };
}

export async function signApproval({ privateJwk, owner, repo, pr, headSha }) {
  const key = await subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const msg = new TextEncoder().encode(approvalMessage({ owner, repo, pr, headSha }));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, msg));
  return `R-120 SIGNED: pr=${Number(pr)} sha=${String(headSha).toLowerCase()} sig=${bytesToBase64url(sig)}`;
}

async function main() {
  if (process.argv.includes('--keygen')) {
    process.stdout.write(JSON.stringify(await keygen(), null, 2) + '\n');
    return;
  }
  const owner = arg('owner', 'StellarEdgeServices');
  const repo = arg('repo', 'otterquote-platform');
  const pr = arg('pr');
  const sha = arg('sha');
  const keyPath = arg('key');
  if (!pr || !sha || !/^[0-9a-fA-F]{40}$/.test(sha)) {
    process.stderr.write('usage: sign.mjs --key private.jwk --pr <n> --sha <40hex> [--owner O --repo R]\n');
    process.exit(2);
  }
  const raw = keyPath ? readFileSync(keyPath, 'utf8') : process.env.R120_PRIVATE_JWK;
  if (!raw) { process.stderr.write('no private key: pass --key <file> or set R120_PRIVATE_JWK\n'); process.exit(2); }
  const parsed = JSON.parse(raw);
  const privateJwk = parsed.privateJwk || parsed; // accept keygen output or a bare JWK
  process.stdout.write((await signApproval({ privateJwk, owner, repo, pr, headSha: sha })) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { process.stderr.write(`${e.message}\n`); process.exit(1); });
}
