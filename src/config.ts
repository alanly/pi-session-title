import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface TitleSettings {
  provider: string;
  modelId: string;
}

export type TitleModel = ReturnType<ExtensionContext["modelRegistry"]["find"]>;
export type TitleModelRegistry = Pick<ExtensionContext["modelRegistry"], "find">;

interface RawSessionTitle {
  enabled?: unknown;
  provider?: unknown;
  modelId?: unknown;
}

export function readTitleSettings(settings: unknown): TitleSettings | undefined {
  if (typeof settings !== "object" || settings === null) return undefined;
  const sessionTitle = (settings as { sessionTitle?: unknown }).sessionTitle;
  if (typeof sessionTitle !== "object" || sessionTitle === null) return undefined;

  const { enabled, provider, modelId } = sessionTitle as RawSessionTitle;
  if (enabled !== undefined && typeof enabled !== "boolean") return undefined;
  if (enabled === false) return undefined;
  if (typeof provider !== "string" || typeof modelId !== "string") return undefined;

  const trimmedProvider = provider.trim();
  const trimmedModelId = modelId.trim();
  if (trimmedProvider === "" || trimmedModelId === "") return undefined;

  return { provider: trimmedProvider, modelId: trimmedModelId };
}

export function resolveTitleModel(
  registry: TitleModelRegistry,
  config: TitleSettings | undefined,
): TitleModel {
  if (!config) return undefined;
  return registry.find(config.provider, config.modelId);
}
