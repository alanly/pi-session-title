import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

export type TitleJobOutcome = "saved" | "failed" | "cancelled";
type JobContext = Pick<ExtensionContext, "sessionManager">;

export interface TitleJobController {
  start(ctx: JobContext, generate: (signal: AbortSignal) => Promise<string | undefined>): Promise<TitleJobOutcome>;
}

export function latestNameEntryId(entries: readonly SessionEntry[]): string | undefined {
  // Pi reads the name across all branches. A cleared name still creates an entry.
  return entries.findLast((entry) => entry.type === "session_info")?.id;
}

interface TitleJob {
  sessionId: string;
  nameEntryId: string | undefined;
  controller: AbortController;
}

export function createTitleJobs(pi: Pick<ExtensionAPI, "on" | "setSessionName">): TitleJobController {
  let stopped = false;
  let active: TitleJob | undefined;

  function cancelActive(): void {
    const job = active;
    active = undefined;
    job?.controller.abort();
  }

  function isCurrent(job: TitleJob, ctx: JobContext): boolean {
    if (stopped || active !== job) return false;
    try {
      const session = ctx.sessionManager;
      return session.getSessionId() === job.sessionId && latestNameEntryId(session.getEntries()) === job.nameEntryId;
    } catch {
      return false;
    }
  }

  pi.on("session_shutdown", () => {
    stopped = true;
    cancelActive();
  });
  pi.on("session_before_tree", cancelActive);
  pi.on("session_tree", cancelActive);
  pi.on("session_info_changed", (_event, ctx) => {
    if (active && !isCurrent(active, ctx)) cancelActive();
  });

  return {
    async start(ctx, generate) {
      cancelActive();
      if (stopped) return "cancelled";

      let job: TitleJob;
      try {
        const session = ctx.sessionManager;
        job = {
          sessionId: session.getSessionId(),
          nameEntryId: latestNameEntryId(session.getEntries()),
          controller: new AbortController(),
        };
      } catch {
        return "cancelled";
      }
      active = job;

      try {
        let title: string | undefined;
        try {
          title = await generate(job.controller.signal);
        } catch {
          return isCurrent(job, ctx) ? "failed" : "cancelled";
        }
        if (!isCurrent(job, ctx)) return "cancelled";
        if (!title?.trim()) return "failed";

        // Retire before the setter emits session_info_changed.
        active = undefined;
        pi.setSessionName(title);
        return "saved";
      } catch {
        return "failed";
      } finally {
        if (active === job) active = undefined;
      }
    },
  };
}
