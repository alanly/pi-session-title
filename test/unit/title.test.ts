import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildContextExcerpt, buildPromptExcerpt, requestTitle } from "../../src/title.ts";

type Stream = ExtensionContext["modelRegistry"]["streamSimple"];
type Result = Awaited<ReturnType<ReturnType<Stream>["result"]>>;
type Message = Parameters<typeof buildContextExcerpt>[0][number];

const model: Parameters<Stream>[0] = {
  api: "openai-completions",
  provider: "local-test",
  id: "test-model",
  name: "Test model",
  baseUrl: "http://unused.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 1024,
};

const text = (value: string) => ({ type: "text" as const, text: value });
const user = (content: Extract<Message, { role: "user" }>["content"]): Message => ({
  role: "user", content, timestamp: 0,
});
const response = (
  content: string | Result["content"],
  stopReason: Result["stopReason"] = "stop",
): Result => ({
  role: "assistant",
  content: typeof content === "string" ? [text(content)] : content,
  stopReason,
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { ...model.cost, total: 0 },
  },
  timestamp: 0,
});

// The helper uses only result(); any attempt to iterate this fake stream fails.
const streamResult = (result: ReturnType<Stream>["result"]): ReturnType<Stream> =>
  ({ result }) as ReturnType<Stream>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const ask = (result: Result) => requestTitle(
  { streamSimple: () => streamResult(async () => result) },
  model,
  "Improve workspace navigation",
  new AbortController().signal,
);

const attachment = (body: string) => `<file name="/project/private.txt">\n${body}\n</file>`;
const skill = (body: string) =>
  `<skill name="review" location="/project/skills/review/SKILL.md">\nReferences are relative to /project/skills/review.\n\n${body}\n</skill>`;

test("strips expanded Pi attachments and skill boilerplate before capping prompt text", () => {
  const prompt = [
    attachment("FILE_SECRET".repeat(1_500)),
    '<file name="/project/image.png">Image resize hint</file>',
    '<file name="/project/empty-image.png"></file>',
    skill("SKILL_SECRET"),
    "Fix parser performance for Unicode input",
  ].join("\n\n");
  assert.equal(buildPromptExcerpt(prompt), "Fix parser performance for Unicode input");
  assert.equal(buildPromptExcerpt(`${attachment("FILE_SECRET")}\n${skill("SKILL_SECRET")}`), "");
  assert.equal(buildPromptExcerpt(" \t\n"), "");
  assert.equal(buildPromptExcerpt("Implement parser support for <file> elements"),
    "Implement parser support for <file> elements");
});

test("does not mistake an inline closing tag in a Pi multiline file for its wrapper", () => {
  assert.equal(buildPromptExcerpt(`${attachment("Example: </file> inline\n</file> followed by FILE_SECRET")}\nFix XML parsing`),
    "Fix XML parsing");
  assert.equal(buildPromptExcerpt('Task introduction\n<file name="/project/incomplete">\nFILE_SECRET'),
    "Task introduction");
});

test("keeps the start of an oversized prompt without cutting a surrogate pair", () => {
  const head = "Task: ";
  assert.equal(buildPromptExcerpt(head + "x".repeat(8_000)).length, 6_000);
  const prefix = head + "x".repeat(5_999 - head.length);
  assert.equal(buildPromptExcerpt(prefix + "😀 trailing details"), prefix);
});

test("context uses projected conversation text and compaction summaries only", () => {
  const image = { type: "image" as const, data: "IMAGE_SECRET", mimeType: "image/png" };
  const messages: Message[] = [
    { role: "system", content: "SYSTEM_SECRET", timestamp: 0 },
    { role: "branchSummary", summary: "ABANDONED_SECRET", fromId: null, timestamp: 0 },
    { role: "compactionSummary", summary: `${attachment("SUMMARY_FILE_SECRET")}\nEarlier goal`, tokensBefore: 0, timestamp: 0 },
    user("Investigate regressions"),
    user([text(attachment("USER_FILE_SECRET")), image, text(`${skill("SKILL_SECRET")}\nFix sorting`)]),
    response([
      { type: "thinking", thinking: "THINKING_SECRET", redacted: true },
      { type: "toolCall", id: "tool-id", name: "read", arguments: { path: "TOOL_ARG_SECRET" } },
      text(`${attachment("ASSISTANT_FILE_SECRET")}\nFound a comparator bug`),
    ]),
    { role: "toolResult", toolCallId: "tool-id", toolName: "read", content: [text("RESULT_SECRET")], isError: false, timestamp: 0 },
    { role: "bashExecution", command: "COMMAND_SECRET", output: "BASH_SECRET", exitCode: 0, cancelled: false, truncated: false, fullOutputPath: undefined, timestamp: 0 },
    { role: "custom", customType: "test", content: "CUSTOM_SECRET", display: false, timestamp: 0 },
  ];
  const excerpt = buildContextExcerpt(messages);
  assert.match(excerpt, /Earlier goal[\s\S]*Investigate regressions[\s\S]*Fix sorting[\s\S]*Found a comparator bug/);
  assert.doesNotMatch(excerpt, /SECRET|\/project\/|<\/?(?:file|skill)\b/);
  assert.equal(buildContextExcerpt([user([image, text(attachment("FILE_SECRET"))]), messages[0], messages[1]]), "");
});

test("context gives the input budget to recent messages instead of older history", () => {
  const excerpt = buildContextExcerpt([
    user("OLD_HISTORY"),
    user("x".repeat(8_000)),
    response("Newest result"),
    user("Latest task"),
  ]);
  assert.ok(excerpt.length <= 6_000);
  assert.match(excerpt, /Newest result[\s\S]*Latest task/);
  assert.doesNotMatch(excerpt, /OLD_HISTORY/);
  assert.equal(buildContextExcerpt([]), "");
  const tail = "x".repeat(5_993);
  assert.equal(buildContextExcerpt([user(`Earlier 😀${tail}`)]), `User: ${tail}`);
});

test("requests a separate tool-free title with a bounded excerpt and token limit", async () => {
  const controller = new AbortController();
  const excerpt = "Z".repeat(7_000);
  for (const maxTokens of [1024, 24]) {
    const chosen = { ...model, maxTokens };
    let calls = 0;
    const result = await requestTitle({
      streamSimple(selected, context, options) {
        calls++;
        assert.equal(selected, chosen);
        assert.match(context.systemPrompt ?? "", /title/i);
        assert.match(context.systemPrompt ?? "", /one|single/i);
        assert.equal(context.tools?.length ?? 0, 0);
        assert.equal(context.messages.length, 1);
        const [message] = context.messages;
        assert.equal(message.role, "user");
        if (message.role === "user") assert.equal(message.content, "Z".repeat(6_000));
        assert.equal(options?.cacheRetention, "none");
        assert.equal(options?.reasoning, undefined);
        assert.equal(options?.maxTokens, Math.min(64, maxTokens));
        assert.ok(options?.signal);
        assert.notEqual(options.signal, controller.signal);
        assert.equal(options.signal.aborted, false);
        return streamResult(async () => response([
          { type: "thinking", thinking: "Not part of the title" },
          text("  Workspace navigation  "),
        ]));
      },
    }, chosen, excerpt, controller.signal);
    // Provider exceptions are swallowed, so also require a successful result.
    assert.equal(result, "Workspace navigation");
    assert.equal(calls, 1);
  }
});

test("allows for reasoning tokens before the title without exceeding the model limit", async () => {
  for (const [maxTokens, expectedBudget] of [[1024, 512], [384, 384]]) {
    const chosen = { ...model, reasoning: true, maxTokens };
    const result = await requestTitle({
      streamSimple(_model, _context, options) {
        assert.equal(options?.maxTokens, expectedBudget);
        assert.equal(options?.reasoning, "low");
        return streamResult(async () => response([
          { type: "thinking", thinking: "Select the main topic" },
          text("Fix pagination test"),
        ]));
      },
    }, chosen, "Fix an off-by-one error in a pagination test.", new AbortController().signal, "low");
    assert.equal(result, "Fix pagination test");
  }
});

test("strips terminal controls while keeping printable single-line Unicode", async () => {
  assert.equal(await ask(response("\x1b[31m修复缓存 🧑‍💻\x1b[0m")), "修复缓存 🧑‍💻");
  assert.equal(await ask(response("\x1b]8;;https://hidden.invalid\x07Café\x1b]8;;\x1b\\ \x1bPdiscard\x1b\\الملفات\x00")),
    "Café الملفات");
  assert.equal(await ask(response("\x9b31mCache\x9b0m")), "Cache");
  assert.equal(await ask(response("😀".repeat(72))), "😀".repeat(72));
});

test("rejects empty, multiline, malformed Unicode, and too-long output", async () => {
  for (const invalid of [
    "", " \x1b[0m ", "\u200b\u200d", "A\nB", "A\rB", "A\u0085B", "A\u2028B", "A\u2029B",
    "x".repeat(73), "😀".repeat(73), "broken\ud800",
  ]) {
    assert.equal(await ask(response(invalid)), undefined, JSON.stringify(invalid));
  }
  assert.equal(await ask(response([text("Title A"), text("Title B")])), undefined);
  assert.equal(await ask(response([
    text("Title"), { type: "toolCall", id: "tool-id", name: "read", arguments: {} },
  ])), undefined);
});

test("requires a successful stop and handles synchronous and asynchronous failures", async () => {
  const reasons = ["length", "pending", "toolUse", "error", "aborted", "deferred"] as const;
  for (const reason of reasons) assert.equal(await ask(response("Ignore this", reason)), undefined, reason);
  const fail = () => { throw new Error("Private provider failure"); };
  const signal = new AbortController().signal;
  assert.equal(await requestTitle({ streamSimple: fail }, model, "Task", signal), undefined);
  assert.equal(await requestTitle({ streamSimple: () => streamResult(async () => fail()) }, model, "Task", signal), undefined);
});

test("does not call the registry for an empty excerpt or a pre-aborted request", async () => {
  let calls = 0;
  const registry = { streamSimple: () => {
    calls++;
    return streamResult(async () => response("Should not run"));
  } };
  assert.equal(await requestTitle(registry, model, " \n ", new AbortController().signal), undefined);
  assert.equal(await requestTitle(registry, model, "Task", AbortSignal.abort()), undefined);
  assert.equal(calls, 0);
});

test("caller abort resolves promptly even if the provider ignores cancellation", async () => {
  const controller = new AbortController();
  const pending = deferred<Result>();
  let providerSignal: AbortSignal | undefined;
  const result = requestTitle({
    streamSimple(_model, _context, options) {
      providerSignal = options?.signal;
      return streamResult(() => pending.promise);
    },
  }, model, "Task", controller.signal);
  assert.ok(providerSignal);
  controller.abort();
  assert.ok(providerSignal.aborted);
  assert.equal(await result, undefined);
  pending.resolve(response("Late result"));
  assert.equal(await result, undefined);
});

test("deadline aborts and resolves at five seconds without waiting for a provider that ignores it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred<Result>();
  const controller = new AbortController();
  let providerSignal: AbortSignal | undefined;
  const result = requestTitle({
    streamSimple(_model, _context, options) {
      providerSignal = options?.signal;
      return streamResult(() => pending.promise);
    },
  }, model, "Task", controller.signal);
  assert.ok(providerSignal);
  t.mock.timers.tick(4_999);
  assert.equal(providerSignal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(providerSignal.aborted, true);
  assert.equal(controller.signal.aborted, false);
  assert.equal(await result, undefined);
  pending.reject(new Error("Late provider failure"));
  assert.equal(await result, undefined);
});

test("a same-tick provider completion cannot win over caller cancellation", async () => {
  const controller = new AbortController();
  const pending = deferred<Result>();
  const result = requestTitle({ streamSimple: () => streamResult(() => pending.promise) }, model, "Task", controller.signal);
  pending.resolve(response("Ignore this"));
  controller.abort();
  assert.equal(await result, undefined);
});

test("clears the deadline as soon as the request completes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let providerSignal: AbortSignal | undefined;
  const result = await requestTitle({
    streamSimple(_model, _context, options) {
      providerSignal = options?.signal;
      return streamResult(async () => response("Completed"));
    },
  }, model, "Task", new AbortController().signal);
  assert.equal(result, "Completed");
  assert.ok(providerSignal);
  t.mock.timers.tick(5_000);
  assert.equal(providerSignal.aborted, false);
});
