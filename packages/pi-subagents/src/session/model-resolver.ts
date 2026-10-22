/**
 * Model resolution: exact match ("provider/modelId") with fuzzy fallback.
 */
import type { Model } from "@earendil-works/pi-ai";

export interface ModelRegistry {
  find(provider: string, modelId: string): Model<any> | undefined;
  getAll(): Model<any>[];
  getAvailable?(): Model<any>[];
}

/** Successful model resolution — `model` is the resolved or inherited model instance. */
export interface ModelResolutionResult {
  model: Model<any> | undefined;
  error?: undefined;
}

/** Failed resolution of an explicitly specified model (agent profile or tool parameter). */
export interface ModelResolutionError {
  model?: undefined;
  error: string;
}

/** Discriminated union returned by `resolveInvocationModel`. */
export type ModelResolution = ModelResolutionResult | ModelResolutionError;

/**
 * Resolve the effective model for an agent invocation.
 *
 * Encapsulates the fallback policy used in `Agent.execute`:
 * 1. No `modelInput` (`undefined`) → inherit `parentModel`.
 * 2. `modelInput` resolves → return the resolved model.
 * 3. `modelInput` fails → return `{ error }`. A model chosen explicitly (agent profile
 *    or tool parameter) is never replaced by the parent model; `modelFromParams` only
 *    labels the error's origin. An explicit empty or all-whitespace value also fails:
 *    only omission inherits.
 */
export function resolveInvocationModel(
  parentModel: Model<any> | undefined,
  modelInput: string | undefined,
  modelFromParams: boolean,
  registry: ModelRegistry | undefined,
): ModelResolution {
  if (modelInput === undefined) return { model: parentModel };
  if (!registry) return { error: "No model registry available." };
  const resolved = resolveModel(modelInput, registry);
  if (typeof resolved !== "string") return { model: resolved };
  const source = modelFromParams ? "tool parameter" : "agent profile";
  return { error: `${resolved}\n\nExplicit model from ${source} must resolve; not inheriting the parent model.` };
}

/**
 * Resolve a model string to a Model instance.
 * A qualified "provider/modelId" is an exact pin against available models: it never
 * falls back to fuzzy matching, so a typo, another provider, or an unauthenticated
 * model fails instead of silently selecting a sibling. Qualified input is compared
 * case-insensitively, but the registry lookup uses the matched model's canonical
 * provider/id. Unqualified input is fuzzy-matched. Empty or all-whitespace input is
 * invalid rather than a query that matches everything.
 * Returns the Model on success, or an error message string on failure.
 */
export function resolveModel(
  input: string,
  registry: ModelRegistry,
): Model<any> | string {
  // Available models (those with auth configured)
  const all = registry.getAvailable?.() ?? registry.getAll();

  // 0. Empty or all-whitespace values are invalid explicit models, not fuzzy queries.
  if (input.trim() === "") return formatNotFound(input, all);

  // 1. Qualified "provider/modelId": exact pin only — no fuzzy fallback
  const slashIdx = input.indexOf("/");
  if (slashIdx !== -1) {
    const matched = all.find(m => `${m.provider}/${m.id}`.toLowerCase() === input.toLowerCase());
    if (matched) {
      const found = registry.find(matched.provider, matched.id);
      if (found) return found;
    }
    return formatNotFound(input, all);
  }

  // 2. Fuzzy match unqualified names against available models
  const bestMatch = findBestFuzzyMatch(all, input.toLowerCase());
  if (bestMatch) {
    const found = registry.find(bestMatch.provider, bestMatch.id);
    if (found) return found;
  }

  // 3. No match — list available models
  return formatNotFound(input, all);
}

/** Build the shared "model not found" message with the available-model list. */
function formatNotFound(input: string, all: Model<any>[]): string {
  const modelList = all
    .map(m => `  ${m.provider}/${m.id}`)
    .sort()
    .join("\n");
  return `Model not found: "${input}".\n\nAvailable models:\n${modelList}`;
}

/**
 * Score each candidate model — prefer exact id match > id contains > name
 * contains > provider+id contains — and return the best match at or above
 * the acceptance threshold (20), or undefined if nothing scores high enough.
 */
function findBestFuzzyMatch(all: Model<any>[], query: string): Model<any> | undefined {
  let bestMatch: Model<any> | undefined;
  let bestScore = 0;

  for (const m of all) {
    const id = m.id.toLowerCase();
    const name = m.name.toLowerCase();
    const full = `${m.provider}/${m.id}`.toLowerCase();

    let score = 0;
    if (id === query || full === query) {
      score = 100; // exact
    } else if (id.includes(query) || full.includes(query)) {
      score = 60 + (query.length / id.length) * 30; // substring, prefer tighter matches
    } else if (name.includes(query)) {
      score = 40 + (query.length / name.length) * 20;
    } else if (query.split(/[\s\-/]+/).every(part => id.includes(part) || name.includes(part) || m.provider.toLowerCase().includes(part))) {
      score = 20; // all parts present somewhere
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = m;
    }
  }

  return bestScore >= 20 ? bestMatch : undefined;
}
