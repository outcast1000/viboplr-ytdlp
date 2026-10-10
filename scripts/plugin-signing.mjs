#!/usr/bin/env node
// VENDORED from outcast1000/viboplr scripts/plugin-signing.mjs — re-copy it
// rather than editing it here; the payload format and the trusted keys are a
// contract with the app's Rust verifier.
//
// Sign a plugin for main-realm loading. Publishing half of
// src-tauri/src/plugin_signing.rs — read that module's doc first.
//
// Only a plugin that cannot run on the worker runtime needs this (today:
// vinyl-deck). Plugin repos vendor this file and call `sign` then `verify` from
// their package step, before zipping, so `signature.sig` ships inside the
// release zip.
//
//   node plugin-signing.mjs payload <plugin-dir>   print the signed payload
//   node plugin-signing.mjs sign <plugin-dir>      write <plugin-dir>/signature.sig
//   node plugin-signing.mjs verify <plugin-dir>    check it against TRUSTED_PLUGIN_KEYS
//
// `sign` shells out to `tauri signer sign`, which reads the key from
// TAURI_SIGNING_PRIVATE_KEY (or _PATH) and TAURI_SIGNING_PRIVATE_KEY_PASSWORD.
// Use the PLUGIN-signing key, never the app updater key.
//
// `verify` exists because the app REFUSES a plugin whose signature doesn't
// match (it reads as tampered), so a release must never ship one: CI runs it
// before publishing. Dependency-free — Node's crypto has Ed25519 and BLAKE2b.
//
// The payload format and the trusted keys are a contract with the Rust verifier;
// change both together (src-tauri/tests/fixtures/plugin-signing pins them).

import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PAYLOAD_HEADER = "viboplr-plugin-signature:v1";
export const SIGNATURE_FILE = "signature.sig";

/** Mirrors TRUSTED_PLUGIN_KEYS in plugin_signing.rs (base64 of the .pub file). */
export const TRUSTED_PLUGIN_KEYS = [
  // minisign key id 15B3CD58A11504F3 (2026-10-04)
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDE1QjNDRDU4QTExNTA0RjMKUldUekJCV2hXTTJ6RlpacHRmZFFYOFVDZWk3YmJLTXFlQlZGTlkyMmV6QXVvbk03dFRZblhiTU4K",
];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** The exact text a plugin signature covers. Mirrors `signing_payload` in Rust. */
export function payload(manifestBytes, codeBytes) {
  return `${PAYLOAD_HEADER}\nmanifest.json sha256=${sha256(manifestBytes)}\nindex.js sha256=${sha256(codeBytes)}\n`;
}

function payloadForDir(dir) {
  return payload(readFileSync(join(dir, "manifest.json")), readFileSync(join(dir, "index.js")));
}

/** Second line of a minisign file (the base64 blob after the untrusted comment). */
function minisignBlob(b64File) {
  const text = Buffer.from(b64File.trim(), "base64").toString("utf8");
  const line = text.split("\n")[1];
  if (!line) throw new Error("not a minisign file");
  return Buffer.from(line.trim(), "base64");
}

/**
 * Verify a minisign signature (as written by `tauri signer sign`, base64 of the
 * .sig text) over `message` against a base64 minisign public key.
 *
 * Same rule as the Rust side's `verify(.., allow_legacy = false)`: only the
 * prehashed form ("ED", a signature over the BLAKE2b-512 of the message — what
 * `tauri signer` writes) is accepted; a legacy "Ed" signature is refused there,
 * so it is refused here. The trusted comment's global signature is not checked
 * — neither side relies on the comment.
 */
export function verifySignature(message, signatureB64, publicKeyB64) {
  const pk = minisignBlob(publicKeyB64); // "Ed" | keyid(8) | key(32)
  const sig = minisignBlob(signatureB64); // "ED" | keyid(8) | sig(64)
  if (pk.length !== 42 || sig.length !== 74) return false;
  if (!pk.subarray(2, 10).equals(sig.subarray(2, 10))) return false; // different key id
  if (sig.subarray(0, 2).toString("latin1") !== "ED") return false;
  const signed = createHash("blake2b512").update(message).digest();
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pk.subarray(10).toString("base64url") }, format: "jwk" });
  return cryptoVerify(null, signed, key, sig.subarray(10));
}

/** Does `<dir>/signature.sig` verify against one of `keys`? */
export function verifyDir(dir, keys = TRUSTED_PLUGIN_KEYS) {
  const sig = readFileSync(join(dir, SIGNATURE_FILE), "utf8");
  const message = payloadForDir(dir);
  return keys.some((k) => {
    try {
      return verifySignature(message, sig, k);
    } catch (e) {
      // A malformed key or signature is a "no"; the caller reports the outcome.
      console.error(`Signature check against a trusted key failed: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  });
}

function sign(dir) {
  const work = mkdtempSync(join(tmpdir(), "viboplr-plugin-sign-"));
  try {
    const file = join(work, "payload.txt");
    writeFileSync(file, payloadForDir(dir));
    const res = spawnSync("npx", ["--yes", "@tauri-apps/cli@2", "signer", "sign", file], {
      stdio: ["ignore", "inherit", "inherit"],
      env: process.env,
    });
    if (res.status !== 0) throw new Error(`tauri signer sign exited ${res.status}`);
    // tauri writes <file>.sig: the base64 of the minisign signature text.
    const sig = readFileSync(`${file}.sig`, "utf8").trim();
    writeFileSync(join(dir, SIGNATURE_FILE), `${sig}\n`);
    console.log(`Wrote ${join(dir, SIGNATURE_FILE)}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const [cmd, dir] = process.argv.slice(2);
  if (!dir || !["payload", "sign", "verify"].includes(cmd)) {
    console.error("usage: plugin-signing.mjs payload|sign|verify <plugin-dir>");
    process.exit(2);
  }
  if (cmd === "payload") process.stdout.write(payloadForDir(dir));
  else if (cmd === "sign") sign(dir);
  else if (verifyDir(dir)) console.log(`${join(dir, SIGNATURE_FILE)} verifies against a trusted Viboplr key.`);
  else {
    console.error(`${join(dir, SIGNATURE_FILE)} does NOT verify against any trusted key — the app would refuse this plugin.`);
    process.exit(1);
  }
}
