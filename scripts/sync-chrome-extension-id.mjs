#!/usr/bin/env node

import { createHash, createPublicKey } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const [manifestPath, pemPath] = process.argv.slice(2);
if (!manifestPath || !pemPath) {
  throw new Error("Usage: sync-chrome-extension-id.mjs <manifest.json> <private-key.pem>");
}

const privateKey = await readFile(pemPath);
const publicDer = createPublicKey(privateKey).export({ type: "spki", format: "der" });
const publicKeyBase64 = publicDer.toString("base64");
const hex = createHash("sha256").update(publicDer).digest("hex").slice(0, 32);
const extensionId = [...hex].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.key !== publicKeyBase64) {
  manifest.key = publicKeyBase64;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

process.stdout.write(`${extensionId}\n`);
