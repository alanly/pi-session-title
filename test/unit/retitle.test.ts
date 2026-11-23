import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
  SessionInfoChangedEvent,
  SessionInfoEntry,
} from "@earendil-works/pi-coding-agent";
import { createTitleJobs } from "../../src/jobs.ts";
import type { TitleSettings } from "../../src/config.ts";
import { registerRetitle } from "../../src/retitle.ts";

// ---------------------------------------------------------------------------
// Types and fixtures
// ---------------------------------------------------------------------------

type Projection = ReturnType<ExtensionContext["sessionManager"]["buildSessionProjection"]>;
type ProjectionMessages = Projection["messages"];
type Message = ProjectionMessages[number];
type Stream = ExtensionContext["modelRegistry"]["streamSimple"];
type Result = Awaited<ReturnType<ReturnType<Stream>["result"]>>;

const titleModel: NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>> = {
  api: "openai-completions",
  provider: "fixture",
  id: "title-model",
  name: "Title model",
  baseUrl: "http://unused.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 1024,
} as unknown as typeof titleModel;

const settings: TitleSettings = { provider: "fixture", modelId: "title-model" };

const text = (value: string) => ({ type: "text" as const, text: value });
const user = (content: string): Message =>
  ({ role: "user", content, timestamp: 0 }) as unknown as Message;
const assistant = (content: string): Message =>
  ({ role: "assistant", content, timestamp: 0 }) as unknown as Message;
const compaction = (summary: string): Message =>
  ({ role: "compactionSummary", summary, tokensBefore: 0, timestamp: 0 }) as unknown as Message;

const response = (content: string): Result => ({
  role: "assistant",
  content: [text(content)],
  stopReason: "stop",
  api: titleModel.api,
  provider: titleModel.provider,
  model: titleModel.id,
  usage: {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  timestamp: 0,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type AnyHandler = (event: any, ctx: any) => unknown;

interface RegisteredCommand {
  name: string;
  description?: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

function createFakePi() {
  const commands: RegisteredCommand[] = [];
  const savedNames: string[] = [];
  const handlers = new Map<string, AnyHandler[]>();

  const pi = {
    registerCommand(name: string, options: Omit<RegisteredCommand, "name">) {
      commands.push({ name, ...options });
    },
    on(event: string, handler: AnyHandler) {
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

  const emit = (event: { type: string }, ctx: ExtensionCommandContext) => {
    for (const handler of [...(handlers.get(event.type) ?? [])]) void handler(event, ctx);
  };

  return { pi: pi as unknown as ExtensionAPI, commands, savedNames, handlers, emit };
}

function sessionInfoEntry(id: string, name: string | undefined): SessionInfoEntry {
  return { type: "session_info", id, parentId: null, timestamp: "2025-01-01T00:00:00.000Z", name };
}

function createFakeSession(options: {
  name?: string;
  projection?: ProjectionMessages;
  extraEntries?: readonly SessionEntry[];
} = {}) {
  let nextId = 1;
  const entries: SessionEntry[] = [...(options.extraEntries ?? [])];
  if (options.name !== undefined) entries.push(sessionInfoEntry(`entry-${nextId++}`, options.name));
  const projection = options.projection ?? [];
  return {
    appendSessionInfo(name: string | undefined) {
      const entry = sessionInfoEntry(`entry-${nextId++}`, name);
      entries.push(entry);
      return entry;
    },
    entries: () => entries.slice(),
    sessionManager: {
      getSessionId: () => "session-a",
      getEntries: () => entries.slice(),
      buildSessionProjection: () => ({ messages: projection }) as Projection,
    },
  };
}

interface FakeCtxOptions {
  idle?: boolean;
  hasUI?: boolean;
  session?: ReturnType<typeof createFakeSession>;
  messages?: ProjectionMessages;
  model?: typeof titleModel | undefined;
  respond?: () => Result | Promise<Result>;
}

function createFakeCtx(options: FakeCtxOptions) {
  const notifications: { message: string; type?: string }[] = [];
  const findCalls: [string, string][] = [];
  const requests: { model: unknown; content: unknown; systemPrompt: unknown; reasoning?: string }[] = [];
  const session = options.session ?? createFakeSession({ projection: options.messages });

  const ctx = {
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
    },
    mode: "tui",
    hasUI: options.hasUI ?? true,
    cwd: "/project",
    isIdle: () => options.idle ?? true,
    isProjectTrusted: () => true,
    signal: undefined,
    sessionManager: session.sessionManager,
    modelRegistry: {
      find(provider: string, modelId: string) {
        findCalls.push([provider, modelId]);
        return options.model;
      },
      streamSimple(model: unknown, context: any, streamOptions: Parameters<Stream>[2]) {
        requests.push({
          model,
          content: context.messages?.[0]?.content,
          systemPrompt: context.systemPrompt,
          reasoning: streamOptions?.reasoning,
        });
        return {
          result: async () => {
            if (!options.respond) throw new Error("no canned provider response");
            return await options.respond();
          },
        };
      },
    },
  } as unknown as ExtensionCommandContext;

  return { ctx, notifications, findCalls, requests, session };
}

function setup(options: {
  settings?: TitleSettings | undefined;
  ctx?: FakeCtxOptions;
} = {}) {
  const fakePi = createFakePi();
  const jobs = createTitleJobs(fakePi.pi);
  const getSettingsCalls: (TitleSettings | undefined)[] = [];
  registerRetitle(fakePi.pi, jobs, () => {
    const value = options.settings;
    getSettingsCalls.push(value);
    return value;
  });
  const command = fakePi.commands.find((command) => command.name === "retitle");
  assert.ok(command, "/retitle must be registered");
  return { fakePi, jobs, command, getSettingsCalls, emit: fakePi.emit };
}

function infoChangedEvent(name: string | undefined): SessionInfoChangedEvent {
  return { type: "session_info_changed", name };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test("registerRetitle registers a single /retitle command with a description", () => {
  const { fakePi } = setup();
  assert.deepEqual(fakePi.commands.map((command) => command.name), ["retitle"]);
  assert.ok(typeof fakePi.commands[0].description === "string" && fakePi.commands[0].description !== "");
  assert.equal(typeof fakePi.commands[0].handler, "function");
});

// ---------------------------------------------------------------------------
// Busy agent
// ---------------------------------------------------------------------------

test("/retitle while the agent is busy asks to retry and never calls the provider", async () => {
  const { command } = setup({ settings });
  const fake = createFakeCtx({
    idle: false,
    model: titleModel,
    messages: [user("Fix the sorting bugs")],
    respond: () => response("Sorting fixes"),
  });

  await command.handler("", fake.ctx);

  assert.equal(fake.requests.length, 0, "no provider request while busy");
  assert.deepEqual(fake.session.entries(), [], "no session writes while busy");
  assert.equal(fake.notifications.length, 1);
  assert.match(fake.notifications[0].message, /after|once|finish/);
  assert.match(fake.notifications[0].message, /retitle/i);
});

test("/retitle while busy stays silent without a UI", async () => {
  const { command } = setup({ settings });
  const fake = createFakeCtx({
    idle: false,
    hasUI: false,
    model: titleModel,
    messages: [user("Fix the sorting bugs")],
    respond: () => response("Sorting fixes"),
  });

  await command.handler("", fake.ctx);
  assert.deepEqual(fake.notifications, []);
  assert.equal(fake.requests.length, 0);
});

// ---------------------------------------------------------------------------
// Excerpt source: current, compacted, and edited active context
// ---------------------------------------------------------------------------

test("/retitle titles from the projected active context, not raw session entries", async () => {
  const { command } = setup({ settings });
  // Raw entries contain an abandoned branch and the pre-edit original prompt;
  // the projection contains only the edited active context plus compaction.
  const abandoned = {
    type: "message",
    id: "entry-abandoned",
    parentId: null,
    timestamp: "2025-01-01T00:00:00.000Z",
    message: { role: "user", content: "ABANDONED_SECRET original request" },
  } as unknown as SessionEntry;
  const session = createFakeSession({
    name: "Old title",
    projection: [
      compaction("Compacted earlier work on the sorting module"),
      user("Fix the sorting bugs in the edited request"),
      assistant("I fixed the comparator and added tests"),
    ],
    extraEntries: [abandoned],
  });
  const fake = createFakeCtx({
    session,
    model: titleModel,
    respond: () => response("Fix sorting bugs"),
  });

  await command.handler("", fake.ctx);

  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].model, titleModel);
  const content = fake.requests[0].content;
  assert.equal(typeof content, "string");
  assert.match(content as string, /Compaction summary: Compacted earlier work/);
  assert.match(content as string, /User: Fix the sorting bugs in the edited request/);
  assert.match(content as string, /Assistant: I fixed the comparator and added tests/);
  assert.doesNotMatch(content as string, /ABANDONED_SECRET/);
  assert.deepEqual(fake.findCalls, [["fixture", "title-model"]]);
});

// ---------------------------------------------------------------------------
// Nothing to do: missing settings, missing model, no usable text
// ---------------------------------------------------------------------------

test("/retitle with no sessionTitle settings notifies a generic reason and skips the provider", async () => {
  const { command, getSettingsCalls } = setup({ settings: undefined });
  const fake = createFakeCtx({ model: titleModel, messages: [user("Fix the sorting bugs")], respond: () => response("Sorting fixes") });

  await command.handler("", fake.ctx);

  assert.equal(fake.requests.length, 0);
  assert.deepEqual(fake.findCalls, [], "the registry is not consulted without settings");
  assert.deepEqual(fake.session.entries(), []);
  assert.equal(fake.notifications.length, 1);
  assert.match(fake.notifications[0].message, /configur/i);
  assert.equal(getSettingsCalls.length, 1);
});

test("/retitle with an unresolvable title model notifies a generic reason and skips the provider", async () => {
  const { command } = setup({ settings });
  const fake = createFakeCtx({ model: undefined, messages: [user("Fix the sorting bugs")], respond: () => response("Sorting fixes") });

  await command.handler("", fake.ctx);

  assert.equal(fake.requests.length, 0);
  assert.deepEqual(fake.session.entries(), []);
  assert.equal(fake.notifications.length, 1);
  assert.match(fake.notifications[0].message, /model|configur/i);
  assert.ok(!/fixture|title-model|provider/i.test(fake.notifications[0].message.replace(/model/i, "")),
    "the reason must not expose provider details");
});

test("/retitle honors an explicit model-supported thinking level", async () => {
  const { command, fakePi } = setup({ settings: { ...settings, thinkingLevel: "high" } });
  const fake = createFakeCtx({
    model: { ...titleModel, reasoning: true },
    messages: [user("Fix the sorting bugs")],
    respond: () => response("Sorting fixes"),
  });

  await command.handler("", fake.ctx);

  assert.equal(fake.requests[0]?.reasoning, "high");
  assert.deepEqual(fakePi.savedNames, ["Sorting fixes"]);
});

test("/retitle does not send an unsupported explicit level or raise the default above low", async () => {
  const model = {
    ...titleModel,
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high" },
  };
  for (const thinkingLevel of [undefined, "off"] as const) {
    const { command, fakePi } = setup({ settings: { ...settings, thinkingLevel } });
    const fake = createFakeCtx({
      model,
      messages: [user("Fix the sorting bugs")],
      respond: () => response("Sorting fixes"),
    });

    await command.handler("", fake.ctx);

    assert.equal(fake.requests.length, 0);
    assert.deepEqual(fakePi.savedNames, []);
    assert.equal(fake.notifications[0]?.type, "warning");
    assert.match(fake.notifications[0]?.message ?? "", /thinking level/i);
  }
});

test("/retitle with no usable conversation text notifies a generic reason and skips the provider", async () => {
  const { command } = setup({ settings });
  const fake = createFakeCtx({ model: titleModel, messages: [], respond: () => response("Sorting fixes") });

  await command.handler("", fake.ctx);

  assert.equal(fake.requests.length, 0);
  assert.deepEqual(fake.session.entries(), []);
  assert.equal(fake.notifications.length, 1);
  assert.match(fake.notifications[0].message, /text|conversation|nothing/i);
});

test("headless /retitle with no usable text stays silent", async () => {
  const { command } = setup({ settings });
  const fake = createFakeCtx({ hasUI: false, model: titleModel, messages: [] });

  await command.handler("", fake.ctx);
  assert.deepEqual(fake.notifications, []);
  assert.equal(fake.requests.length, 0);
});

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

test("a successful /retitle saves the generated title without a notification", async () => {
  const { command, fakePi } = setup({ settings });
  const fake = createFakeCtx({
    session: createFakeSession({ name: "Old title", projection: [user("Fix the sorting bugs")] }),
    model: titleModel,
    respond: () => response("Fix sorting bugs"),
  });

  await command.handler("", fake.ctx);

  assert.deepEqual(fakePi.savedNames, ["Fix sorting bugs"]);
  assert.deepEqual(fake.notifications, [], "success is silent; the name change is the feedback");
});

test("a failed generation keeps the current name and notifies a generic reason", async () => {
  const { command, fakePi } = setup({ settings });
  const fake = createFakeCtx({
    session: createFakeSession({ name: "Old title", projection: [user("Fix the sorting bugs")] }),
    model: titleModel,
    respond: () => { throw new Error("Private provider failure"); },
  });

  await command.handler("", fake.ctx);

  assert.deepEqual(fakePi.savedNames, [], "the current name is kept");
  const infos = fake.session.entries().filter((entry) => entry.type === "session_info");
  assert.equal(infos.length, 1, "no session_info entry is appended");
  assert.ok(infos[0].type === "session_info" && infos[0].name === "Old title");
  assert.equal(fake.notifications.length, 1);
  assert.match(fake.notifications[0].message, /could not|failed|unable/i);
  assert.ok(!/Private provider failure/.test(fake.notifications[0].message),
    "the reason must not expose provider details");
});

test("cancellation is not a failure: no notification and no save", async () => {
  const { command, fakePi, emit } = setup({ settings });
  const pending = deferred<Result>();
  const fake = createFakeCtx({
    session: createFakeSession({ name: "Old title", projection: [user("Fix the sorting bugs")] }),
    model: titleModel,
    respond: () => pending.promise,
  });
  const done = command.handler("", fake.ctx);
  assert.equal(fake.requests.length, 1);

  // The user renames the session while the title request is in flight.
  fake.session.appendSessionInfo("Manual name");
  emit(infoChangedEvent("Manual name"), fake.ctx);

  pending.resolve(response("Generated title"));
  await done;

  assert.deepEqual(fakePi.savedNames, [], "the manual name wins");
  assert.deepEqual(fake.notifications, [], "cancellation is not reported as a failure");
});

test("args are accepted and ignored", async () => {
  const { command, fakePi } = setup({ settings });
  const fake = createFakeCtx({
    model: titleModel,
    messages: [user("Fix the sorting bugs")],
    respond: () => response("Fix sorting bugs"),
  });

  await command.handler("whatever args", fake.ctx);
  assert.deepEqual(fakePi.savedNames, ["Fix sorting bugs"]);
});
