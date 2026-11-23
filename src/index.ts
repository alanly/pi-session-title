import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readTitleSettings, resolveTitleModel, resolveTitleThinkingLevel, type TitleSettings } from "./config.ts";
import { createTitleJobs, latestNameEntryId } from "./jobs.ts";
import { registerRetitle } from "./retitle.ts";
import { buildPromptExcerpt, requestTitle } from "./title.ts";

export default function sessionTitle(pi: ExtensionAPI): void {
  const jobs = createTitleJobs(pi);
  let settings: TitleSettings | undefined;
  let firstUserRunSeen = false;

  pi.on("session_start", () => {
    settings = readTitleSettings(pi.getSettings());
  });
  registerRetitle(pi, jobs, () => settings);

  pi.on("before_agent_start", (event, ctx) => {
    if (event.messageType !== "user" || firstUserRunSeen) return;
    // The first user run consumes the opportunity even if it is ineligible or fails.
    firstUserRunSeen = true;
    if (!settings || !ctx.sessionManager.getSessionFile()) return;

    // Use the whole file, not just the current branch or projected context.
    const entries = ctx.sessionManager.getEntries();
    if (latestNameEntryId(entries) !== undefined) return;
    if (entries.some((entry) =>
      entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"))) return;

    const excerpt = buildPromptExcerpt(event.prompt);
    if (!excerpt) return;
    const model = resolveTitleModel(ctx.modelRegistry, settings);
    if (!model) return;
    const thinkingLevel = resolveTitleThinkingLevel(model, settings.thinkingLevel);
    if (!thinkingLevel) return;

    // Pi awaits this hook; do not return the job or delay the main model request.
    void jobs.start(ctx, (signal) => requestTitle(ctx.modelRegistry, model, excerpt, signal, thinkingLevel)).catch(() => {
      // Automatic naming is best effort. Do not expose provider errors.
    });
  });
}
