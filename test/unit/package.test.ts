import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const manifestUrl = new URL("../../package.json", import.meta.url);
const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));

test("declares the Pi host as a peer and ships no runtime dependencies", () => {
  assert.equal(manifest.name, "pi-session-title");
  assert.equal(manifest.type, "module");
  assert.equal(manifest.peerDependencies["@earendil-works/pi-ai"], "*");
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
  assert.equal(manifest.devDependencies["@earendil-works/pi-coding-agent"], "1.6.0");
  assert.deepEqual(manifest.dependencies ?? {}, {});
});

test("the declared TypeScript entry exports an extension factory", async () => {
  assert.deepEqual(manifest.pi.extensions, ["./src/index.ts"]);
  const { default: extension } = await import(new URL(manifest.pi.extensions[0], manifestUrl).href);
  assert.equal(typeof extension, "function");
});
