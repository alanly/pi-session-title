import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";

const entry = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
// Resolve the pinned npm installation, not a developer's global `pi`.
const piCli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const provider = "fixture";
export const mainModel = "fixture-main";

export interface ChatRequest {
  model: string;
  messages: { role: string; content: unknown }[];
  stream?: boolean;
  tools?: unknown[];
  [key: string]: unknown;
}

interface FixtureOptions {
  settings?: Record<string, unknown>;
  /** Extra model IDs on the same loopback provider, e.g. a separate title model. */
  modelIds?: readonly string[];
  /** Called after the request is recorded. Await a gate here to delay this reply only. */
  reply?: (request: ChatRequest) => string | Promise<string>;
}

interface RunOptions {
  mode?: "print" | "json";
  args?: readonly string[];
  extensions?: readonly string[];
}

export async function createPiFixture(t: TestContext, options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-session-title-"));
  const home = join(root, "home");
  const tmp = join(root, "tmp");
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const sessionDir = join(root, "sessions");
  const requests: ChatRequest[] = [];
  const children = new Map<ChildProcess, Promise<void>>();

  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    try {
      req.setEncoding("utf8");
      let data = "";
      for await (const chunk of req) data += chunk;
      const request: ChatRequest = JSON.parse(data);
      const requestNumber = requests.push(request);
      const content = await (options.reply?.(request) ?? "Mock reply");
      const message = { role: "assistant", content };
      const metadata = {
        id: `chatcmpl-${requestNumber}`,
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      };
      if (request.stream) {
        const chunk = { ...metadata, object: "chat.completion.chunk", choices: [{ index: 0, delta: message, finish_reason: "stop" }] };
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
      } else {
        const completion = { ...metadata, object: "chat.completion", choices: [{ index: 0, message, finish_reason: "stop" }] };
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(completion));
      }
    } catch (error) {
      // Tests can throw from their handler to simulate a failed completion.
      res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: String(error) } }));
    }
  });

  t.after(async () => {
    for (const child of children.keys()) child.kill("SIGKILL");
    await Promise.all(children.values());
    if (server.listening) {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    }
    await rm(root, { recursive: true, force: true });
  });

  await Promise.all([home, tmp, agentDir, cwd, sessionDir].map((dir) => mkdir(dir)));
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock provider did not get a TCP address");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  const settings = { cacheWarming: "off", retry: { enabled: false }, ...options.settings };
  const models = {
    providers: {
      [provider]: {
        api: "openai-completions",
        apiKey: "fixture-key",
        baseUrl,
        models: [...new Set([mainModel, ...(options.modelIds ?? [])])].map((id) => ({ id })),
      },
    },
  };
  await Promise.all([
    writeFile(join(agentDir, "settings.json"), JSON.stringify(settings)),
    writeFile(join(agentDir, "models.json"), JSON.stringify(models)),
  ]);

  // Kept separate from runPi so tests can also drive the CLI over RPC.
  function spawnPi(args: readonly string[], extensions: readonly string[] = [entry]) {
    const child = spawn(process.execPath, [
      piCli, "--offline", "--no-approve", "--no-extensions", "--no-tools",
      "--no-context-files", "--no-skills", "--no-prompt-templates",
      "--session-dir", sessionDir, "--model", `${provider}/${mainModel}`,
      ...extensions.flatMap((path) => ["-e", path]), ...args,
    ], {
      cwd,
      env: {
        // Do not inherit provider keys, proxy variables, or Pi overrides from the test runner.
        HOME: home,
        USERPROFILE: home,
        TMPDIR: tmp,
        TEMP: tmp,
        TMP: tmp,
        PI_CODING_AGENT_DIR: agentDir,
        PI_TELEMETRY: "0",
        NO_COLOR: "1",
      },
      stdio: "pipe",
      timeout: 15_000,
      killSignal: "SIGKILL",
    });
    children.set(child, new Promise<void>((resolve) => {
      child.once("close", () => {
        children.delete(child);
        resolve();
      });
    }));
    return child;
  }

  async function runPi(prompt: string, { mode = "print", args = [], extensions }: RunOptions = {}) {
    const modeArgs = mode === "print" ? ["--print"] : ["--mode", "json"];
    const child = spawnPi([...modeArgs, ...args, "--", prompt], extensions);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.stdin.end();
    const [code, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
    return { code, signal, stdout, stderr };
  }

  async function sessionFiles() {
    const entries = await readdir(sessionDir, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(entry.parentPath, entry.name)).sort();
  }

  async function readSessionEntries(file: string): Promise<(SessionHeader | SessionEntry)[]> {
    const content = await readFile(file, "utf8");
    return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }

  return { root, agentDir, cwd, sessionDir, baseUrl, requests, spawnPi, runPi, sessionFiles, readSessionEntries };
}
