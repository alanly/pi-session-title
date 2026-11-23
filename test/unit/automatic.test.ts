import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import sessionTitle from "../../src/index.ts";

test("skip custom starts and claim the first user run before history or a title result exists", async () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const names: string[] = [];
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(event, handler); },
    getSettings: () => ({ sessionTitle: { provider: "fixture", modelId: "title" } }),
    setSessionName(name: string) { names.push(name); },
    registerCommand() {},
  };
  let calls = 0;
  let fail!: (error: Error) => void;
  const pending = new Promise<never>((_resolve, reject) => { fail = reject; });
  const ctx = {
    sessionManager: {
      getSessionFile: () => "fixture-session.jsonl",
      getSessionId: () => "fixture-session",
      getEntries: () => [],
    },
    modelRegistry: {
      find: () => ({ maxTokens: 64 }),
      streamSimple() {
        calls++;
        return { result: () => pending };
      },
    },
  };
  sessionTitle(pi as unknown as ExtensionAPI);
  handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
  const before = handlers.get("before_agent_start")!;
  const user = { type: "before_agent_start", messageType: "user", prompt: "Explain the first user run" };
  try {
    before({ type: "before_agent_start", messageType: "custom" }, ctx);
    assert.equal(calls, 0);
    assert.equal(before(user, ctx), undefined, "the hook must not return the title job");
    assert.equal(calls, 1, "a custom run must not claim the attempt");
    before(user, ctx);
    assert.equal(calls, 1, "a pending attempt must not be replaced even before history is saved");
    fail(new Error("Private provider error"));
    await setImmediate();
    before(user, ctx);
    assert.equal(calls, 1, "a failed attempt must not be retried even without recorded history");
    assert.deepEqual(names, []);
  } finally {
    handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx);
  }
});
