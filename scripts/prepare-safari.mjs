import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const stagingDir = process.argv[2];
if (!stagingDir) throw new Error("Usage: node prepare-safari.mjs <staging-directory>");

const manifestPath = join(stagingDir, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const macosManifest = structuredClone(manifest);
const iosManifest = structuredClone(manifest);
iosManifest.permissions = (iosManifest.permissions ?? []).filter((permission) => permission !== "webRequest");
delete iosManifest.background.type;
iosManifest.background.service_worker = "src/background.js";

// Safari 15.4+ supports Manifest V3 and service-worker backgrounds on both
// platforms. webRequest remains macOS-only; iOS uses content-script traffic
// observation and persistent storage across worker suspension.
delete macosManifest.background.type;
macosManifest.background.service_worker = "src/background.js";
const iosManifestPath = join(stagingDir, "Platforms/iOS/manifest.json");
const macosManifestPath = join(stagingDir, "Platforms/macOS/manifest.json");
await mkdir(join(stagingDir, "Platforms/iOS"), { recursive: true });
await mkdir(join(stagingDir, "Platforms/macOS"), { recursive: true });
await writeFile(iosManifestPath, `${JSON.stringify(iosManifest, null, 2)}\n`);
await writeFile(macosManifestPath, `${JSON.stringify(macosManifest, null, 2)}\n`);
// Keep the root manifest iOS-safe for folder-based inspection; Xcode packages
// the platform-specific manifests below for each extension target.
await writeFile(manifestPath, `${JSON.stringify(iosManifest, null, 2)}\n`);

const mediaPath = join(stagingDir, "src/core/media.js");
const dlnaPath = join(stagingDir, "src/core/dlna.js");
const backgroundPath = join(stagingDir, "src/background.js");
const media = (await readFile(mediaPath, "utf8")).replace(/^export\s+/gm, "");
const dlna = (await readFile(dlnaPath, "utf8")).replace(/^export\s+/gm, "");
const background = (await readFile(backgroundPath, "utf8")).replace(/^import\s+[^;]+;\s*/gm, "");
await writeFile(backgroundPath, `// Safari 15.4+ Manifest V3 background bundle (generated)\n// macOS uses webRequest; iOS/iPadOS use content-script traffic observation.\nconst mediatraceIOS = /iPhone|iPad|iPod/.test(navigator.platform) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);\nglobalThis.MEDIATRACE_WEB_REQUEST_ENABLED = !mediatraceIOS;\n${media}\n${dlna}\n${background}`);
