import assert from "node:assert/strict";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import { createPiFixture, mainModel, type ChatRequest } from "../fixtures/pi.ts";

const titleModel = "fixture-tools/session-title";
const configured = {
  settings: { sessionTitle: { provider: "fixture", modelId: titleModel } },
  modelIds: [titleModel],
};
const title = "Test the title workflow";
const mainReply = "Here is the main answer.";
const prompt = "Explain how to test the title workflow.";
const followUp = "What else should the test check?";

type Fixture = Awaited<ReturnType<typeof createPiFixture>>;

function assertMainResult(result: Awaited<ReturnType<Fixture["runPi"]>>) {
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim(), mainReply);
}

async function onlySession(fixture: Fixture) {
  const files = await fixture.sessionFiles();
  assert.equal(files.length, 1);
  return files[0];
}

function names(entries: (SessionHeader | SessionEntry)[]) {
  return entries.flatMap((entry) => entry.type === "session_info" ? [entry.name] : []);
}

function userPayload(request: ChatRequest) {
  return request.messages.filter((message) => message.role === "user").map((message) => message.content);
}

function textContent(text: string) {
  return [{ type: "text", text }];
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => { resolve = release; });
  return { promise, resolve };
}

async function waitFor(check: () => boolean | Promise<boolean>, description: string, timeoutMs = 5_000) {
  const deadline = performance.now() + timeoutMs;
  do {
    if (await check()) return;
    await delay(20);
  } while (performance.now() < deadline);
  assert.fail(`Timed out waiting for ${description}`);
}

test("automatic title is saved while the first main request is in flight and not repeated", async (t) => {
  const mainArrived = gate();
  const releaseMain = gate();
  const fixture = await createPiFixture(t, {
    ...configured,
    async reply(request) {
      // The fixture records each request before calling reply(). If the title
      // blocks before_agent_start, neither request can finish.
      if (request.model === titleModel) {
        await mainArrived.promise;
        return title;
      }
      mainArrived.resolve();
      await releaseMain.promise;
      return mainReply;
    },
  });
  // Multiple CLI messages run as consecutive turns in one extension runtime.
  const run = fixture.runPi(followUp, { args: [prompt] });
  try {
    await waitFor(() => fixture.requests.some((request) => request.model === mainModel), "main request with title response gated");
    await waitFor(() => fixture.requests.some((request) => request.model === titleModel), "configured title request");
    await waitFor(async () => {
      const [file] = await fixture.sessionFiles();
      if (!file) return false;
      const entries = await fixture.readSessionEntries(file);
      assert.ok(!entries.some((entry) => entry.type === "message" && entry.message.role === "assistant"));
      return entries.some((entry) => entry.type === "session_info" && entry.name === title);
    }, "persisted session_info title before main reply");
  } finally {
    mainArrived.resolve();
    releaseMain.resolve();
    await run;
  }

  assertMainResult(await run);
  assert.deepEqual(fixture.requests.map((request) => request.model).sort(), [mainModel, mainModel, titleModel].sort());
  const [titleRequest] = fixture.requests.filter((request) => request.model === titleModel);
  assert.deepEqual(titleRequest.messages.map((message) => message.role), ["system", "user"]);
  assert.deepEqual(userPayload(titleRequest), [prompt]);
  assert.equal(titleRequest.tools?.length ?? 0, 0);
  const [first, second] = fixture.requests.filter((request) => request.model === mainModel);
  assert.deepEqual(userPayload(first), [textContent(prompt)]);
  assert.deepEqual(userPayload(second), [textContent(prompt), textContent(followUp)]);
  assert.deepEqual(second.messages.filter((message) => message.role === "assistant").map((message) => message.content), [mainReply]);

  const entries = await fixture.readSessionEntries(await onlySession(fixture));
  const conversation = entries.flatMap((entry) => entry.type === "message" && entry.message.role !== "system" ? [entry.message] : []);
  assert.deepEqual(conversation.map((message) => message.role), ["user", "assistant", "user", "assistant"]);
  for (const message of conversation) {
    if (message.role !== "assistant") continue;
    assert.equal(message.model, mainModel);
    assert.deepEqual(message.content, textContent(mainReply));
  }
  assert.ok(!entries.some((entry) => entry.type === "custom_message"));
  assert.deepEqual(names(entries), [title]);
});

test("resuming an older unnamed session does not title it, even off the recorded conversation branch", async (t) => {
  const fixture = await createPiFixture(t, { ...configured, reply: () => mainReply });
  // Record a real session from a Pi invocation that didn't load the extension.
  assertMainResult(await fixture.runPi(prompt, { extensions: [] }));
  const file = await onlySession(fixture);
  assertMainResult(await fixture.runPi(followUp, { args: ["--session", file] }));
  assert.deepEqual(userPayload(fixture.requests[1]), [textContent(prompt), textContent(followUp)]);

  // A later root can be the active leaf without deleting either earlier turn.
  const emptyBranch = {
    type: "custom", id: "test-empty-branch", parentId: null,
    customType: "test-marker", timestamp: new Date().toISOString(),
  } satisfies SessionEntry;
  await appendFile(file, `${JSON.stringify(emptyBranch)}\n`);
  const branchPrompt = "Start a different branch.";
  assertMainResult(await fixture.runPi(branchPrompt, { args: ["--session", file] }));
  assert.deepEqual(fixture.requests.map((request) => request.model), [mainModel, mainModel, mainModel]);
  assert.deepEqual(userPayload(fixture.requests[2]), [textContent(branchPrompt)]);
  assert.equal(await onlySession(fixture), file);
  assert.deepEqual(names(await fixture.readSessionEntries(file)), []);
});

test("an explicit name or clear before the first prompt suppresses automatic titling", async (t) => {
  const manual = "A manually chosen name";
  for (const clear of [false, true]) {
    await t.test(clear ? "cleared name" : "existing name", async (t) => {
      const fixture = await createPiFixture(t, { ...configured, reply: () => mainReply });
      const args = ["--name", manual];
      if (clear) {
        const extension = join(fixture.root, "clear-name.ts");
        await writeFile(extension, `export default (pi) => pi.on("session_start", () => { pi.setSessionName(""); });\n`);
        args.push("-e", extension);
      }
      assertMainResult(await fixture.runPi(prompt, { args }));
      assert.deepEqual(fixture.requests.map((request) => request.model), [mainModel]);
      assert.deepEqual(names(await fixture.readSessionEntries(await onlySession(fixture))), clear ? [manual, ""] : [manual]);
    });
  }
});

test("an attachment-only first prompt is not usable, and a later text prompt is not titled", async (t) => {
  const fixture = await createPiFixture(t, { ...configured, reply: () => mainReply });
  const attachment = "Contents of the attachment, not user task text.";
  await writeFile(join(fixture.cwd, "note.txt"), attachment);
  // Pi adds the @file to the first message, whose only task text is whitespace.
  assertMainResult(await fixture.runPi(followUp, { args: ["@note.txt", " "] }));
  assert.deepEqual(fixture.requests.map((request) => request.model), [mainModel, mainModel]);
  assert.ok(JSON.stringify(userPayload(fixture.requests[0])).includes(attachment), "Pi sent the attachment in the first main request");
  assert.deepEqual(userPayload(fixture.requests[1]).at(-1), textContent(followUp));
  assert.deepEqual(names(await fixture.readSessionEntries(await onlySession(fixture))), []);
});

test("--no-session suppresses the title request", async (t) => {
  const fixture = await createPiFixture(t, { ...configured, reply: () => mainReply });
  assertMainResult(await fixture.runPi(prompt, { args: ["--no-session"] }));
  assert.deepEqual(fixture.requests.map((request) => request.model), [mainModel]);
  assert.deepEqual(await fixture.sessionFiles(), []);
});

test("print mode exits normally while the title reply is still blocked", async (t) => {
  const titleArrived = gate();
  const releaseTitle = gate();
  const fixture = await createPiFixture(t, {
    ...configured,
    async reply(request) {
      if (request.model === titleModel) {
        titleArrived.resolve();
        await releaseTitle.promise;
        return title;
      }
      // Give the detached title request a chance to reach the provider before exit.
      await titleArrived.promise;
      return mainReply;
    },
  });
  let finished = false;
  const run = fixture.runPi(prompt).finally(() => { finished = true; });
  try {
    await waitFor(() => fixture.requests.some((request) => request.model === titleModel), "blocked title request");
    // The reply stays gated through exit. Take less than requestTitle's 5 s
    // timeout so waiting for that timeout at shutdown cannot pass the test.
    await waitFor(() => finished, "print exit without waiting for the title timeout", 4_000);
    assertMainResult(await run);
    assert.deepEqual(names(await fixture.readSessionEntries(await onlySession(fixture))), []);
    assert.deepEqual(fixture.requests.map((request) => request.model).sort(), [mainModel, titleModel].sort());
  } finally {
    titleArrived.resolve();
    releaseTitle.resolve();
    await run;
  }
});
