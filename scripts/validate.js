#!/usr/bin/env node
/**
 * Pre-publish validation for pi-flamegraph.
 *
 * Runs with no dependencies (node built-ins only) and checks:
 *   1. package.json manifest (name/version, pi-package keyword, pi.extensions)
 *   2. every extension path exists on disk
 *   3. the inline RENDERER_JS is syntactically valid JavaScript and contains
 *      no template-literal interpolation (which the outer TS template string
 *      would evaluate at build time, corrupting the renderer).
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

function fail(msg) {
  console.error("✖ " + msg);
  process.exit(1);
}
function ok(msg) {
  console.log("  ✓ " + msg);
}

// 1. Manifest ------------------------------------------------------------
let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
} catch (e) {
  fail("package.json is not valid JSON: " + e.message);
}

if (!pkg.name || !pkg.version) fail("package.json must have a name and version");
ok(`name: ${pkg.name}@${pkg.version}`);

if (!Array.isArray(pkg.keywords) || pkg.keywords.indexOf("pi-package") === -1) {
  fail('keywords must include "pi-package" (required for the package gallery)');
}
ok('keyword "pi-package" present');

const pi = pkg.pi;
if (!pi || !Array.isArray(pi.extensions) || pi.extensions.length === 0) {
  fail("pi.extensions must be a non-empty array");
}
ok(`pi.extensions: ${JSON.stringify(pi.extensions)}`);

for (const ext of pi.extensions) {
  const clean = ext.replace(/^\.\//, "");
  if (!fs.existsSync(path.join(root, clean))) fail(`extension path does not exist: ${ext}`);
}
ok("all pi.extensions paths exist on disk");

if (pi.image !== undefined && !/^https?:\/\//.test(pi.image)) {
  fail("pi.image should be an absolute http(s) URL");
}
if (pi.image) ok(`pi.image: ${pi.image}`);

// 2. Inline renderer JS --------------------------------------------------
const renderer = fs.readFileSync(path.join(root, "extensions/renderer.ts"), "utf8");

const startMarker = "const RENDERER_JS = `";
const start = renderer.indexOf(startMarker);
if (start === -1) fail("RENDERER_JS constant not found in renderer.ts");

const bodyStart = start + startMarker.length;
const end = renderer.indexOf("`", bodyStart);
if (end === -1) fail("RENDERER_JS closing backtick not found");

const js = renderer.slice(bodyStart, end);
if (js.length === 0) fail("RENDERER_JS is empty");
ok(`RENDERER_JS extracted (${js.length} chars)`);

if (js.indexOf("${") !== -1) {
  fail("RENDERER_JS contains template-literal interpolation — it would be evaluated by the outer TS template string");
}
ok("no template-literal interpolation in RENDERER_JS");

try {
  new vm.Script(js);
  ok("RENDERER_JS is syntactically valid JavaScript");
} catch (e) {
  fail("RENDERER_JS syntax error: " + e.message);
}

if (renderer.indexOf("export function renderFlameGraphHtml") === -1) {
  fail("renderFlameGraphHtml export not found in renderer.ts");
}
ok("renderFlameGraphHtml export present");

console.log("\n✅ all pre-publish checks passed");
