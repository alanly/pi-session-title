import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { test } from "node:test";
import { createPiFixture, mainModel } from "../fixtures/pi.ts";

test("Pi loads the checkout extension and completes a main request", async (t) => {
  const prompt = "Explain what a smoke test checks.";
  const reply = "A smoke test checks that the basic path works.";
  const fixture = await createPiFixture(t, { reply: () => reply });
  const result = await fixture.runPi(prompt);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim(), reply);
  const userMessage = { role: "user", content: [{ type: "text", text: prompt }] };
  const mainRequests = fixture.requests.filter((request) =>
    isDeepStrictEqual(request.messages.at(-1), userMessage));
  assert.equal(mainRequests.length, 1);
  const [request] = mainRequests;
  assert.equal(request.model, mainModel);
  assert.equal(request.tools?.length ?? 0, 0);

  const files = await fixture.sessionFiles();
  assert.equal(files.length, 1);
  const entries = await fixture.readSessionEntries(files[0]);
  const assistant = entries.find((entry) => entry.type === "message" && entry.message.role === "assistant");
  assert.ok(assistant?.type === "message" && assistant.message.role === "assistant");
  assert.equal(assistant.message.model, mainModel);
  assert.deepEqual(assistant.message.content, [{ type: "text", text: reply }]);
});
