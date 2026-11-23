import assert from "node:assert/strict";
import { test } from "node:test";
import { createPiFixture, mainModel } from "../fixtures/pi.ts";

const titleModel = "fixture-tools/session-title";
const title = "Retitle the saved session";
const mainReply = "The command renames the session from its conversation.";
const prompt = "Describe how the retitle command should behave.";

const previousTitle = "Previous session name";

test("/retitle replaces the name of a saved session from its projected context", async (t) => {
  const fixture = await createPiFixture(t, {
    settings: { sessionTitle: { provider: "fixture", modelId: titleModel } },
    modelIds: [titleModel],
    reply(request) {
      return request.model === titleModel ? title : mainReply;
    },
  });

  const first = await fixture.runPi(prompt, { args: ["--name", previousTitle] });
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stderr, "");
  assert.equal(first.stdout.trim(), mainReply);
  assert.deepEqual(fixture.requests.map((request) => request.model), [mainModel],
    "a named session does not send an automatic title request");

  const second = await fixture.runPi("/retitle", { args: ["--continue"] });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.stderr, "");
  // A handled command adds no messages, so print mode re-prints the last
  // assistant reply of the continued session. No title or protocol noise.
  assert.equal(second.stdout.trim(), mainReply);

  const titleRequests = fixture.requests.filter((request) => request.model === titleModel);
  assert.equal(titleRequests.length, 1);
  const [request] = titleRequests;
  const userMessage = request.messages.find((message) => message.role === "user");
  assert.equal(
    userMessage?.content,
    `User: ${prompt}\n\nAssistant: ${mainReply}`,
    "the request carries the projected conversation excerpt",
  );
  assert.equal(request.tools?.length ?? 0, 0);

  const [file] = await fixture.sessionFiles();
  assert.ok(file, "the continued session file is reused");
  const entries = await fixture.readSessionEntries(file);
  const names = entries.flatMap((entry) => entry.type === "session_info" ? [entry.name] : []);
  assert.deepEqual(names, [previousTitle, title]);
  const roles = entries.flatMap((entry) =>
    entry.type === "message" && entry.message.role !== "system" ? [entry.message.role] : []);
  assert.deepEqual(roles, ["user", "assistant"], "/retitle adds no messages");
});

test("/retitle without title settings is a silent no-op in print mode", async (t) => {
  const fixture = await createPiFixture(t, { reply: () => mainReply });
  const first = await fixture.runPi(prompt);
  assert.equal(first.code, 0, first.stderr);

  const second = await fixture.runPi("/retitle", { args: ["--continue"] });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.stderr, "");
  // The handled command adds no messages; print mode re-prints the last
  // assistant reply of the continued session.
  assert.equal(second.stdout.trim(), mainReply);

  assert.deepEqual(fixture.requests.map((request) => request.model), [mainModel]);
  const [file] = await fixture.sessionFiles();
  const entries = await fixture.readSessionEntries(file);
  assert.ok(!entries.some((entry) => entry.type === "session_info"),
    "no session_info entry is written");
});
