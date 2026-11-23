import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const DEFAULT_THINKING_LEVELS = ["off", "minimal", "low"] as const;

export interface TitleSettings {
  provider: string;
  modelId: string;
  thinkingLevel?: ModelThinkingLevel;
}

export type TitleModel = ReturnType<ExtensionContext["modelRegistry"]["find"]>;
export type TitleModelRegistry = Pick<ExtensionContext["modelRegistry"], "find">;

interface RawSessionTitle {
  enabled?: unknown;
  provider?: unknown;
  modelId?: unknown;
  thinkingLevel?: unknown;
}

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return THINKING_LEVELS.some((level) => level === value);
}

export function readTitleSettings(settings: unknown): TitleSettings | undefined {
  if (typeof settings !== "object" || settings === null) return undefined;
  const sessionTitle = (settings as { sessionTitle?: unknown }).sessionTitle;
  if (typeof sessionTitle !== "object" || sessionTitle === null) return undefined;

  const { enabled, provider, modelId, thinkingLevel } = sessionTitle as RawSessionTitle;
  if (enabled !== undefined && typeof enabled !== "boolean") return undefined;
  if (enabled === false) return undefined;
  if (typeof provider !== "string" || typeof modelId !== "string") return undefined;
  if (thinkingLevel !== undefined && !isThinkingLevel(thinkingLevel)) return undefined;

  const trimmedProvider = provider.trim();
  const trimmedModelId = modelId.trim();
  if (trimmedProvider === "" || trimmedModelId === "") return undefined;

  const config: TitleSettings = { provider: trimmedProvider, modelId: trimmedModelId };
  if (thinkingLevel !== undefined) config.thinkingLevel = thinkingLevel;
  return config;
}

export function resolveTitleModel(
  registry: TitleModelRegistry,
  config: TitleSettings | undefined,
): TitleModel {
  if (!config) return undefined;
  return registry.find(config.provider, config.modelId);
}

export function resolveTitleThinkingLevel(
  model: NonNullable<TitleModel>,
  requested?: ModelThinkingLevel,
): ModelThinkingLevel | undefined {
  const supported = getSupportedThinkingLevels(model);
  if (requested !== undefined) return supported.includes(requested) ? requested : undefined;
  return DEFAULT_THINKING_LEVELS.find((level) => supported.includes(level));
}
