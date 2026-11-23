import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TitleJobController } from "./jobs.ts";
import { resolveTitleModel, resolveTitleThinkingLevel, type TitleSettings } from "./config.ts";
import { buildContextExcerpt, requestTitle } from "./title.ts";

export function registerRetitle(
  pi: Pick<ExtensionAPI, "registerCommand">,
  jobs: TitleJobController,
  getSettings: () => TitleSettings | undefined,
): void {
  pi.registerCommand("retitle", {
    description: "Rename this session from its conversation so far",
    handler: async (_args, ctx) => {
      await retitle(ctx, jobs, getSettings);
    },
  });
}

async function retitle(
  ctx: ExtensionCommandContext,
  jobs: TitleJobController,
  getSettings: () => TitleSettings | undefined,
): Promise<void> {
  if (!ctx.isIdle()) {
    notify(ctx, "Pi is still working. Run /retitle again after this run finishes.", "info");
    return;
  }

  const settings = getSettings();
  if (!settings) {
    notify(ctx, "Session titling is not configured, so /retitle is unavailable.", "warning");
    return;
  }
  const model = resolveTitleModel(ctx.modelRegistry, settings);
  if (!model) {
    notify(ctx, "The configured session title model is not available.", "warning");
    return;
  }

  const thinkingLevel = resolveTitleThinkingLevel(model, settings.thinkingLevel);
  if (!thinkingLevel) {
    const message = settings.thinkingLevel === undefined
      ? "The title model has no low-effort thinking level. Set sessionTitle.thinkingLevel to a supported level."
      : `The title model does not support thinking level "${settings.thinkingLevel}".`;
    notify(ctx, message, "warning");
    return;
  }

  const excerpt = buildContextExcerpt(ctx.sessionManager.buildSessionProjection().messages);
  if (!excerpt) {
    notify(ctx, "There is no conversation text to name this session from yet.", "warning");
    return;
  }

  const outcome = await jobs.start(ctx, (signal) => requestTitle(ctx.modelRegistry, model, excerpt, signal, thinkingLevel));
  if (outcome === "failed") {
    notify(ctx, "Could not generate a session title. The current name is kept.", "warning");
  }
}

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning"): void {
  if (ctx.hasUI) ctx.ui.notify(message, type);
}
