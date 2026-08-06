#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectDir = dirname(scriptDir);
const media = (await readFile(join(projectDir, "src/core/media.js"), "utf8")).replace(/^export\s+/gm, "");
const dlna = (await readFile(join(projectDir, "src/core/dlna.js"), "utf8")).replace(/^export\s+/gm, "");
const background = (await readFile(join(projectDir, "src/background.js"), "utf8")).replace(/^import\s+[^;]+;\s*/gm, "");
const bundle = `// Generated Chromium Manifest V3 background bundle. Do not edit directly.\n${media}\n${dlna}\n${background}`;
// Keep the generated service worker ASCII-only. This prevents Windows editors,
// archive tools and PowerShell versions using a legacy code page from corrupting
// non-ASCII JavaScript string literals. Source files remain readable UTF-8.
const portableBundle = bundle.replace(/[^\x00-\x7F]/g, (character) =>
  `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
await writeFile(join(projectDir, "src/background.bundle.js"), portableBundle, "utf8");
