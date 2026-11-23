import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readTitleSettings,
  resolveTitleModel,
  type TitleSettings,
} from "../../src/config.ts";

type RegistryLike = Parameters<typeof resolveTitleModel>[0];
type TitleModel = NonNullable<ReturnType<RegistryLike["find"]>>;

function makeRegistry(
  known: ReadonlyMap<string, string>,
): { registry: RegistryLike; calls: [provider: string, modelId: string][] } {
  const calls: [string, string][] = [];
  const registry: RegistryLike = {
    find(provider, modelId) {
      calls.push([provider, modelId]);
      const key = `${provider}/${modelId}`;
      if (!known.has(key)) return undefined;
      const model = { provider, id: modelId } as unknown as TitleModel;
      return model;
    },
  };
  return { registry, calls };
}

test("readTitleSettings returns trimmed provider and modelId for a valid sessionTitle", () => {
  const settings = {
    sessionTitle: { provider: "  fixture  ", modelId: "\t fixture-main \n" },
  };
  assert.deepEqual(readTitleSettings(settings), {
    provider: "fixture",
    modelId: "fixture-main",
  });
});

test("readTitleSettings defaults enabled to true", () => {
  assert.deepEqual(
    readTitleSettings({ sessionTitle: { provider: "fixture", modelId: "m" } }),
    { provider: "fixture", modelId: "m" },
  );
  assert.deepEqual(
    readTitleSettings({ sessionTitle: { enabled: true, provider: "fixture", modelId: "m" } }),
    { provider: "fixture", modelId: "m" },
  );
});

test("readTitleSettings preserves exact strings, case, and internal slashes", () => {
  const settings = {
    sessionTitle: { provider: " Fixture ", modelId: " sub/dir/model-Name " },
  };
  assert.deepEqual(readTitleSettings(settings), {
    provider: "Fixture",
    modelId: "sub/dir/model-Name",
  });
});

test("readTitleSettings returns undefined when sessionTitle is missing", () => {
  assert.equal(readTitleSettings(undefined), undefined);
  assert.equal(readTitleSettings(null), undefined);
  assert.equal(readTitleSettings({}), undefined);
  assert.equal(readTitleSettings({ other: { provider: "fixture", modelId: "m" } }), undefined);
  assert.equal(readTitleSettings("sessionTitle"), undefined);
});

test("readTitleSettings returns undefined when disabled", () => {
  const settings = {
    sessionTitle: { enabled: false, provider: "fixture", modelId: "m" },
  };
  assert.equal(readTitleSettings(settings), undefined);
});

test("readTitleSettings returns undefined for malformed settings", () => {
  const malformed: unknown[] = [
    { sessionTitle: null },
    { sessionTitle: "fixture/m" },
    { sessionTitle: ["fixture", "m"] },
    { sessionTitle: { provider: "fixture" } },
    { sessionTitle: { modelId: "m" } },
    { sessionTitle: { provider: 1, modelId: "m" } },
    { sessionTitle: { provider: "fixture", modelId: true } },
    { sessionTitle: { provider: {}, modelId: [] } },
    { sessionTitle: { enabled: "true", provider: "fixture", modelId: "m" } },
    { sessionTitle: { enabled: 1, provider: "fixture", modelId: "m" } },
    { sessionTitle: { provider: "fixture", modelId: "m", extra: "ignored" } },
  ];
  // The last entry keeps unknown keys; only enabled/provider/modelId are validated.
  assert.deepEqual(
    readTitleSettings({ sessionTitle: { provider: "fixture", modelId: "m", extra: "ignored" } }),
    { provider: "fixture", modelId: "m" },
  );
  const skipping = malformed.slice(0, -1);
  for (const settings of skipping) {
    assert.equal(readTitleSettings(settings), undefined, JSON.stringify(settings));
  }
});

test("readTitleSettings returns undefined for blank provider or modelId", () => {
  assert.equal(readTitleSettings({ sessionTitle: { provider: "", modelId: "m" } }), undefined);
  assert.equal(readTitleSettings({ sessionTitle: { provider: "   ", modelId: "m" } }), undefined);
  assert.equal(readTitleSettings({ sessionTitle: { provider: "fixture", modelId: "" } }), undefined);
  assert.equal(
    readTitleSettings({ sessionTitle: { provider: "fixture", modelId: " \t\n " } }),
    undefined,
  );
});

test("resolveTitleModel looks up the configured model with exact strings", () => {
  const { registry, calls } = makeRegistry(new Map([["fixture/title-model", "known"]]));
  const config: TitleSettings = { provider: "fixture", modelId: "title-model" };
  const model = resolveTitleModel(registry, config);
  assert.ok(model);
  assert.equal((model as { id?: string }).id, "title-model");
  assert.deepEqual(calls, [["fixture", "title-model"]]);
});

test("resolveTitleModel returns undefined for unknown models", () => {
  const { registry } = makeRegistry(new Map([["fixture/title-model", "known"]]));
  const model = resolveTitleModel(registry, { provider: "fixture", modelId: "nope" });
  assert.equal(model, undefined);
  assert.equal(resolveTitleModel(registry, { provider: "other", modelId: "title-model" }), undefined);
});

test("resolveTitleModel returns undefined without a config", () => {
  const { registry, calls } = makeRegistry(new Map([["fixture/title-model", "known"]]));
  assert.equal(resolveTitleModel(registry, undefined), undefined);
  assert.deepEqual(calls, []);
});

test("resolveTitleModel never falls back to another provider or model", () => {
  const { registry, calls } = makeRegistry(new Map([["fixture/any", "known"]]));
  // A registry whose find would resolve anything must not be consulted without config,
  // and with a config only the exact provider/modelId pair is requested.
  const model = resolveTitleModel(registry, { provider: "fixture", modelId: "title-model" });
  assert.equal(model, undefined);
  assert.deepEqual(calls, [["fixture", "title-model"]]);
});
