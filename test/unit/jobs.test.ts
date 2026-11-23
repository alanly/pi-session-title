import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeTreeEvent,
  SessionEntry,
  SessionInfoChangedEvent,
  SessionInfoEntry,
  SessionShutdownEvent,
  SessionTreeEvent,
} from "@earendil-works/pi-coding-agent";
import { createTitleJobs, latestNameEntryId } from "../../src/jobs.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AnyHandler = (event: any, ctx: any) => unknown;

function sessionInfoEntry(id: string, name: string | undefined): SessionInfoEntry {
  return { type: "session_info", id, parentId: null, timestamp: "2025-01-01T00:00:00.000Z", name };
}

/** A non-session_info entry used as filler; entry order is all that matters. */
function fillerEntry(id: string): SessionEntry {
  return { type: "custom", id, parentId: null, timestamp: "2025-01-01T00:00:00.000Z", customType: "test" };
}

interface FakeSession {
  sessionId(): string;
  entries(): SessionEntry[];
  setSessionId(id: string): void;
  appendSessionInfo(name: string | undefined): SessionInfoEntry;
  breakAccess(): void;
}

function createFakeSession(options: { sessionId?: string; entries?: SessionEntry[] } = {}): FakeSession {
  let id = options.sessionId ?? "session-a";
  let broken = false;
  let nextEntryId = 1;
  const list = [...(options.entries ?? [])];
  const guard = () => {
    if (broken) throw new Error("stale session context");
  };
  return {
    sessionId: () => {
      guard();
      return id;
    },
    entries: () => {
      guard();
      return list.slice();
    },
    setSessionId(next: string) {
      id = next;
    },
    appendSessionInfo(name) {
      const entry = sessionInfoEntry(`entry-${nextEntryId++}`, name);
      list.push(entry);
      return entry;
    },
    breakAccess() {
      broken = true;
    },
  };
}

function ctxFor(session: FakeSession): Pick<ExtensionContext, "sessionManager"> {
  return {
    sessionManager: {
      getSessionId: session.sessionId,
      getEntries: session.entries,
    },
  } as unknown as Pick<ExtensionContext, "sessionManager">;
}

function createFakePi() {
  const registeredEvents: string[] = [];
  const savedNames: string[] = [];
  const handlers = new Map<string, AnyHandler[]>();

  const pi = {
    on(event: string, handler: AnyHandler) {
      registeredEvents.push(event);
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const current = handlers.get(event) ?? [];
        const index = current.indexOf(handler);
        if (index >= 0) current.splice(index, 1);
      };
    },
    setSessionName(name: string) {
      savedNames.push(name);
    },
  };

  const emit = (event: { type: string }, ctx: Pick<ExtensionContext, "sessionManager">) => {
    for (const handler of [...(handlers.get(event.type) ?? [])]) {
      void handler(event, ctx);
    }
  };

  return {
    pi: pi as unknown as Pick<ExtensionAPI, "on" | "setSessionName">,
    emit,
    registeredEvents,
    savedNames,
  };
}

interface DeferredGenerate {
  generate(signal: AbortSignal): Promise<string | undefined>;
  calls: number;
  signal: AbortSignal | undefined;
  resolve(value: string | undefined): void;
  reject(reason?: unknown): void;
}

function deferredGenerate(): DeferredGenerate {
  let resolve!: (value: string | undefined) => void;
  let reject!: (reason?: unknown) => void;
  const state: DeferredGenerate = {
    calls: 0,
    signal: undefined,
    generate(signal: AbortSignal) {
      state.calls += 1;
      state.signal = signal;
      return new Promise<string | undefined>((res, rej) => {
        resolve = res;
        reject = rej;
      });
    },
    resolve(value) {
      resolve(value);
    },
    reject(reason) {
      reject(reason);
    },
  };
  return state;
}

function infoChangedEvent(name: string | undefined): SessionInfoChangedEvent {
  return { type: "session_info_changed", name };
}

function shutdownEvent(reason: SessionShutdownEvent["reason"] = "quit"): SessionShutdownEvent {
  return { type: "session_shutdown", reason };
}

function beforeTreeEvent(): SessionBeforeTreeEvent {
  return {
    type: "session_before_tree",
    preparation: {
      targetId: "entry-99",
      oldLeafId: null,
      commonAncestorId: null,
      entriesToSummarize: [],
      userWantsSummary: false,
    },
    signal: new AbortController().signal,
  };
}

function treeEvent(): SessionTreeEvent {
  return { type: "session_tree", newLeafId: "entry-99", oldLeafId: null };
}

// ---------------------------------------------------------------------------
// latestNameEntryId
// ---------------------------------------------------------------------------

test("latestNameEntryId returns undefined when no session_info entry exists", () => {
  assert.equal(latestNameEntryId([]), undefined);
  assert.equal(latestNameEntryId([fillerEntry("e1"), fillerEntry("e2")]), undefined);
});

test("latestNameEntryId returns the latest whole-session session_info entry id", () => {
  const entries: SessionEntry[] = [
    sessionInfoEntry("e1", "First"),
    fillerEntry("e2"),
    sessionInfoEntry("e3", "Second"),
    fillerEntry("e4"),
  ];
  assert.equal(latestNameEntryId(entries), "e3");
});

test("latestNameEntryId counts cleared-name entries and ignores their name value", () => {
  const entries: SessionEntry[] = [
    sessionInfoEntry("e1", "Named"),
    fillerEntry("e2"),
    sessionInfoEntry("e3", ""), // cleared name
  ];
  assert.equal(latestNameEntryId(entries), "e3");
});

// ---------------------------------------------------------------------------
// createTitleJobs: registration
// ---------------------------------------------------------------------------

test("createTitleJobs registers each lifecycle handler exactly once", () => {
  const fake = createFakePi();
  createTitleJobs(fake.pi);
  assert.deepEqual([...fake.registeredEvents].sort(), [
    "session_before_tree",
    "session_info_changed",
    "session_shutdown",
    "session_tree",
  ]);
});

// ---------------------------------------------------------------------------
// Successful and failed flows
// ---------------------------------------------------------------------------

test("start saves a generated title over a matching baseline and reports saved", async () => {
  const fake = createFakePi();
  const jobs = createTitleJobs(fake.pi);
  const session = createFakeSession({ entries: [sessionInfoEntry("e1", "Old title")] });
  const gen = deferredGenerate();
  const result = jobs.start(ctxFor(session), gen.generate);

  assert.equal(gen.calls, 1);
  assert.ok(gen.signal instanceof AbortSignal);
  assert.equal(gen.signal!.aborted, false);

  gen.resolve("New title");
  assert.equal(await result, "saved");
  assert.deepEqual(fake.savedNames, ["New title"]);
});

test("start reports failed when generation yields no title", async () => {
  const fake = createFakePi();
  const jobs = createTitleJobs(fake.pi);
  const gen = deferredGenerate();
  const result = jobs.start(ctxFor(createFakeSession()), gen.generate);
  gen.resolve(undefined);
  assert.equal(await result, "failed");
  assert.deepEqual(fake.savedNames, []);
});

test("start reports failed for a whitespace-only title", async () => {
  const fake = createFakePi();
  const jobs = createTitleJobs(fake.pi);
  const gen = deferredGenerate();
  const result = jobs.start(ctxFor(createFakeSession()), gen.generate);
  gen.resolve("   ");
  assert.equal(await result, "failed");
  assert.deepEqual(fake.savedNames, []);
});

test("start reports failed when generation rejects", async () => {
  const fake = createFakePi();
  const jobs = createTitleJobs(fake.pi);
  const gen = deferredGenerate();
  const result = jobs.start(ctxFor(createFakeSession()), gen.generate);
  gen.reject(new Error("provider exploded"));
  assert.equal(await result, "failed");
  assert.deepEqual(fake.savedNames, []);
});

test("start reports failed when the session name cannot be written", async () => {
  const fake = createFakePi();
  fake.pi.setSessionName = () => { throw new Error("session file is read-only"); };
  const jobs = createTitleJobs(fake.pi);
  assert.equal(await jobs.start(ctxFor(createFakeSession()), async () => "New title"), "failed");
});

test("a new job supersedes the active job: abort first, only the newer job saves", async () => {
  const fake = createFakePi();
  const jobs = createTitleJobs(fake.pi);
  const session = createFakeSession();
  const first = deferredGenerate();
  const second = deferredGenerate();
  const firstResult = jobs.start(ctxFor(session), first.generate);
  const firstSignal = first.signal!;
  const secondResult = jobs.start(ctxFor(session), second.generate);

  assert.ok(firstSignal.aborted, "starting a new job aborts the superseded job");
  assert.equal(second.signal!.aborted, false);

  second.resolve("Newer title");
  assert.equal(await secondResult, "saved");

  // The producer of the superseded job ignored the abort signal and still
  // produced a title: the late, stale result must not save.
  first.resolve("Older title");
  assert.equal(await firstResult, "cancelled");
  assert.deepEqual(fake.savedNames, ["Newer title"]);
});

test("a superseded job that rejects still reports cancelled", async () => {
  const fake = createFakePi();
  const jobs = createTitleJobs(fake.pi);
  const first = deferredGenerate();
  const second = deferredGenerate();
  const firstResult = jobs.start(ctxFor(createFakeSession()), first.generate);
  void jobs.start(ctxFor(createFakeSession()), second.generate);

  first.reject(new Error("aborted work failed"));
  assert.equal(await firstResult, "cancelled");
  second.resolve(undefined);
  assert.deepEqual(fake.savedNames, []);
});

test("a superseded job settling late does not retire the newer job", async () => {
  const fake = createFakePi();
  const jobs = createTitleJobs(fake.pi);
  const session = createFakeSession();
  const first = deferredGenerate();
  const second = deferredGenerate();
  const firstResult = jobs.start(ctxFor(session), first.generate);
  const secondResult = jobs.start(ctxFor(session), second.generate);

  // The old job's late finally must not clear the newer active job.
  first.resolve("Older title");
  assert.equal(await firstResult, "cancelled");

  second.resolve("Newer title");
  assert.equal(await secondResult, "saved");
  assert.deepEqual(fake.savedNames, ["Newer title"]);
});

// ---------------------------------------------------------------------------
// Manual edits win: session_info_changed early cancellation
// ---------------------------------------------------------------------------

test("session_info_changed with a newer name entry cancels the active job early", async () => {
  const fake = createFakePi();
  const jobs = createTitleJobs(fake.pi);
  const session = createFakeSession();
  const gen = deferredGenerate();
  const result = jobs.start(ctxFor(session), gen.generate);

  const manual = session.appendSessionInfo("Manual title");
  assert.equal(latestNameEntryId(session.entries()), manual.id);
  fake.emit(infoChangedEvent("Manual title"), ctxFor(session));

  assert.ok(gen.signal!.aborted, "early cancellation aborts the producer");
  gen.resolve("Generated title");
  assert.equal(await result, "cancelled");
  assert.deepEqual(fake.savedNames, []);
});

test("a same-value manual rename still wins over the pending job", async () => {
  const fake = createFakePi();
  const jobs = createTitleJobs(fake.pi);
  const session = createFakeSession({ entries: [sessionInfoEntry("e1", "Same title")] });
  const gen = deferredGenerate();
  const result = jobs.start(ctxFor(session), gen.generate);

  // Manual /name with the same value appends a new session_info entry.
  session.appendSessionInfo("Same title");
  fake.emit(infoChangedEvent("Same title"), ctxFor(session));

  gen.resolve("Same title");
  assert.equal(await result, "cancelled");
  assert.deepEqual(fake.savedNames, []);
});

test("a set-then-clear manual edit wins over the pending job", async () => {
  const fake = createFakePi();
  const jobs = createTitleJobs(fake.pi);
  const session = createFakeSession();
  const gen = deferredGenerate();
  const result = jobs.start(ctxFor(session), gen.generate);

  session.appendSessionInfo("Temporary");
  fake.emit(infoChangedEvent("Temporary"), ctxFor(session));
  session.appendSessionInfo("");
  fake.emit(infoChangedEvent(undefined), ctxFor(session));

  gen.resolve("Generated title");
  assert.equal(await result, "cancelled");
  assert.deepEqual(fake.savedNames, []);
});

test("a manual edit whose event is delayed still blocks the save at the recheck", async () => {
  const fake = createFakePi();
  const jobs = createTitleJobs(fake.pi);
  const session = createFakeSession();
  const gen = deferredGenerate();
  const result = jobs.start(ctxFor(session), gen.generate);

  // Another plugin's slow handlers delay the session_info_changed dispatch,
  // so the entry exists but the event has not reached us yet.
  session.appendSessionInfo("Manual title");

  gen.resolve("Generated title");
  assert.equal(await result, "cancelled");
  assert.deepEqual(fake.savedNames, []);
});

test("a delayed session_info_changed from the job's own save does not cancel a newer job", async () => {
  const fake = createFakePi();
  const jobs = createTitleJobs(fake.pi);
  const session = createFakeSession();
  const first = deferredGenerate();
  const firstResult = jobs.start(ctxFor(session), first.generate);
  first.resolve("First title");
  assert.equal(await firstResult, "saved");

  // The host appended a session_info entry for our own save; a newer job
  // baselines on it and must survive the delayed event from the first save.
  session.appendSessionInfo("First title");
  const second = deferredGenerate();
  const secondResult = jobs.start(ctxFor(session), second.generate);
  fake.emit(infoChangedEvent("First title"), ctxFor(session));

  second.resolve("Second title");
  assert.equal(await secondResult, "saved");
  assert.deepEqual(fake.savedNames, ["First title", "Second title"]);
});

// ---------------------------------------------------------------------------
// Closure lifecycle (session_shutdown)
// ---------------------------------------------------------------------------

test("session_shutdown revokes the runtime: pending jobs cancel and never save", async () => {
  const fake = createFakePi();
  const jobs = createTitleJobs(fake.pi);
  const session = createFakeSession();
  const gen = deferredGenerate();
  const result = jobs.start(ctxFor(session), gen.generate);

  fake.emit(shutdownEvent("reload"), ctxFor(session));
  assert.ok(gen.signal!.aborted, "shutdown aborts the pending producer");

  // Producer ignored the abort signal; the save must still be blocked.
  gen.resolve("Too late");
  assert.equal(await result, "cancelled");
  assert.deepEqual(fake.savedNames, []);
});

test("after session_shutdown, start reports cancelled without invoking the producer", async () => {
  const fake = createFakePi();
  const jobs = createTitleJobs(fake.pi);
  const session = createFakeSession();
  fake.emit(shutdownEvent("new"), ctxFor(session));

  const gen = deferredGenerate();
  const result = jobs.start(ctxFor(session), gen.generate);
  assert.equal(await result, "cancelled");
  assert.equal(gen.calls, 0, "generate must not run on a revoked runtime");
  assert.deepEqual(fake.savedNames, []);
});

test("a revoked runtime never touches a stale session context", async () => {
  const fake = createFakePi();
  const jobs = createTitleJobs(fake.pi);
  const session = createFakeSession();
  const gen = deferredGenerate();
  const result = jobs.start(ctxFor(session), gen.generate);

  fake.emit(shutdownEvent("resume"), ctxFor(session));
  // The captured ctx goes stale after runtime teardown and now throws.
  session.breakAccess();

  gen.resolve("Stale title");
  assert.equal(await result, "cancelled");
  assert.deepEqual(fake.savedNames, []);
});

// ---------------------------------------------------------------------------
// Branch transitions (session_before_tree / session_tree)
// ---------------------------------------------------------------------------

test("session_before_tree cancels the active job", async () => {
  const fake = createFakePi();
  const jobs = createTitleJobs(fake.pi);
  const session = createFakeSession();
  const gen = deferredGenerate();
  const result = jobs.start(ctxFor(session), gen.generate);

  fake.emit(beforeTreeEvent(), ctxFor(session));
  assert.ok(gen.signal!.aborted, "tree navigation aborts the pending producer");

  gen.resolve("Branch title");
  assert.equal(await result, "cancelled");
  assert.deepEqual(fake.savedNames, []);
});

test("session_tree cancels a job that started during navigation", async () => {
  const fake = createFakePi();
  const jobs = createTitleJobs(fake.pi);
  const session = createFakeSession();
  const first = deferredGenerate();
  void jobs.start(ctxFor(session), first.generate);
  fake.emit(beforeTreeEvent(), ctxFor(session));

  // A job that slipped in between the before_tree and tree events.
  const second = deferredGenerate();
  const secondResult = jobs.start(ctxFor(session), second.generate);
  fake.emit(treeEvent(), ctxFor(session));

  assert.ok(second.signal!.aborted);
  second.resolve("Mid-navigation title");
  assert.equal(await secondResult, "cancelled");
  assert.deepEqual(fake.savedNames, []);
});

test("a job started after tree navigation saves normally", async () => {
  const fake = createFakePi();
  const jobs = createTitleJobs(fake.pi);
  const session = createFakeSession();
  fake.emit(beforeTreeEvent(), ctxFor(session));
  fake.emit(treeEvent(), ctxFor(session));

  const gen = deferredGenerate();
  const result = jobs.start(ctxFor(session), gen.generate);
  gen.resolve("Post-navigation title");
  assert.equal(await result, "saved");
  assert.deepEqual(fake.savedNames, ["Post-navigation title"]);
});

// ---------------------------------------------------------------------------
// Session identity
// ---------------------------------------------------------------------------

test("a session id change blocks the save at the recheck", async () => {
  const fake = createFakePi();
  const jobs = createTitleJobs(fake.pi);
  const session = createFakeSession({ sessionId: "session-a" });
  const gen = deferredGenerate();
  const result = jobs.start(ctxFor(session), gen.generate);

  // Session switched before the shutdown event reached us.
  session.setSessionId("session-b");
  gen.resolve("Wrong session title");
  assert.equal(await result, "cancelled");
  assert.deepEqual(fake.savedNames, []);
});

test("session_info_changed from a different session cancels the active job", async () => {
  const fake = createFakePi();
  const jobs = createTitleJobs(fake.pi);
  const sessionA = createFakeSession({ sessionId: "session-a" });
  const sessionB = createFakeSession({ sessionId: "session-b" });
  const gen = deferredGenerate();
  const result = jobs.start(ctxFor(sessionA), gen.generate);

  fake.emit(infoChangedEvent("Other session"), ctxFor(sessionB));
  assert.ok(gen.signal!.aborted);

  gen.resolve("Stale session title");
  assert.equal(await result, "cancelled");
  assert.deepEqual(fake.savedNames, []);
});
