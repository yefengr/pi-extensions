/**
 * create-subagent-session.ts — Assembly factory for born-complete child sessions (issue #265).
 *
 * `createSubagentSession()` does the assembly portion that the old runner's
 * `runAgent()` did up front: detect the environment, assemble the session config,
 * create the SDK session (with the recursion guard as a tool denylist), publish
 * `spawning`/`session-created`, and bind extensions. It returns a fully usable
 * `SubagentSession` — `Subagent` then only coordinates (turn loop, steer, dispose).
 *
 * The factory takes a resolved `cwd` value, never the WorkspaceProvider: `cwd`
 * is a value the factory consumes directly (detectEnv, assembleSessionConfig,
 * createSession), so threading the provider through here would be a relay smell.
 */

import { resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type InlineExtension,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfigLookup } from "#src/config/agent-types";
import type { ChildLifecyclePublisher } from "#src/lifecycle/child-lifecycle";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import { SubagentSession } from "#src/lifecycle/subagent-session";
import { assertDeclaredTools, matchesTool, selectBuiltinExtensions } from "#src/session/builtin-extensions";
import type { EnvInfo } from "#src/session/env";
import type { ModelRegistry } from "#src/session/model-resolver";
import { createPromptInheritanceExtension, inheritPromptOptions } from "#src/session/prompt-inheritance";
import type { CheckpointManager } from "#src/session/recovery-checkpoint";
import { type AssemblerIO, assembleSessionConfig } from "#src/session/session-config";
import type { SessionLease } from "#src/session/session-lease";
import type {
  ParentSessionInfo,
  ShellExec,
  SubagentSessionIdentity,
  SubagentType,
  ThinkingLevel,
} from "#src/types";

/**
 * Recursion guard: names of tools registered by this extension that subagents
 * must NOT inherit. Passed to the SDK as a denylist, which it applies whenever
 * it rebuilds the child's tool registry — including the rebuild triggered by a
 * child extension registering a tool of its own. Filtering the active set once
 * after `bindExtensions` would be undone by that rebuild (#725).
 */
const EXCLUDED_TOOL_NAMES = ["subagent", "get_subagent_result", "steer_subagent"];

// ── IO boundary ───────────────────────────────────────────────────────────────

/** Minimal resource-loader contract used by the factory. */
export interface ResourceLoaderLike {
  reload(): Promise<void>;
}

/** Minimal session-manager contract used by the factory. */
export interface SessionManagerLike {
  newSession(opts: { parentSession?: string }): void;
  getSessionFile(): string | undefined;
  getSessionId(): string;
  getCwd?: CheckpointManager["getCwd"];
  getLeafId?: CheckpointManager["getLeafId"];
  appendCustomEntry?: CheckpointManager["appendCustomEntry"];
}

/** Options passed to EnvironmentIO/SessionFactoryIO methods. */
export interface ResourceLoaderOptions {
  cwd: string;
  agentDir: string;
  /** Settings the loader resolves packages from; defaults to the ambient ones when absent. */
  settingsManager?: SettingsManager;
  noPromptTemplates?: boolean;
  noThemes?: boolean;
  noContextFiles?: boolean;
  extensionFactories?: InlineExtension[];
  systemPromptOverride?: () => string | undefined;
  /** Override the append system prompt. Receives the current base value; return the replacement. */
  appendSystemPromptOverride?: (base: string[]) => string[];
}

/** Options passed to SessionFactoryIO.createSession. */
export interface CreateSessionOptions {
  cwd: string;
  agentDir: string;
  sessionManager: SessionManagerLike;
  settingsManager: SettingsManager;
  modelRegistry: ModelRegistry;
  model?: Model<any>;
  /** Allowlist: only these tool names are enabled in the session. */
  tools: string[];
  /** Denylist applied after `tools`, on every tool-registry rebuild. */
  excludeTools?: string[];
  resourceLoader: ResourceLoaderLike;
  thinkingLevel?: ThinkingLevel;
}

/**
 * Environment discovery - detect runtime context and resolve directories.
 *
 * Decouples the factory from direct process/SDK reads so each can be stubbed
 * independently in tests.
 */
export interface EnvironmentIO {
  detectEnv: (exec: ShellExec, cwd: string) => Promise<EnvInfo>;
  getAgentDir: () => string;
  deriveSessionDir: (parentSessionFile: string | undefined, effectiveCwd: string) => string;
}

/**
 * Session factory - create SDK objects for a child agent session.
 *
 * Decouples the factory from direct Pi SDK imports and sibling-module IO,
 * making it testable via plain stub objects without vi.mock().
 */
export interface SessionFactoryIO {
  createResourceLoader: (opts: ResourceLoaderOptions) => ResourceLoaderLike;
  createSessionManager: (cwd: string, sessionDir: string) => SessionManagerLike;
  createSettingsManager: (cwd: string, agentDir: string, projectTrusted?: boolean) => SettingsManager;
  /**
   * Settings view the child's resource loader resolves packages from.
   * The composition root decides whether any package extensions are excluded;
   * the identity function reproduces the child's default full inheritance.
   */
  createLoaderSettingsManager: (parent: SettingsManager) => SettingsManager;
  createSession: (opts: CreateSessionOptions) => Promise<{ session: AgentSession }>;
  /** Production always supplies lease and read-only target trust lookup. */
  acquireSessionLease?: (file: string, sessionId: string) => SessionLease;
  getProjectTrust?: (cwd: string, agentDir: string) => boolean;
  assemblerIO: AssemblerIO;
}

/**
 * IO boundary injected into createSubagentSession().
 *
 * Intersection of EnvironmentIO and SessionFactoryIO — callers satisfy both
 * sub-interfaces via TypeScript's structural typing.
 */
export type SubagentSessionIO = EnvironmentIO & SessionFactoryIO;

/**
 * Dependencies injected at construction time — the IO boundary plus the two
 * static domain deps (exec, registry) every creation needs.
 */
export interface SubagentSessionDeps {
  io: SubagentSessionIO;
  exec: ShellExec;
  registry: AgentConfigLookup;
  /** Publishes the child-execution lifecycle so consumers can observe it. */
  lifecycle: ChildLifecyclePublisher;
}

/** Per-spawn parameters — the fields that vary per child session. */
export interface CreateSubagentSessionParams {
  snapshot: ParentSnapshot;
  type: SubagentType;
  /** Resolved workspace cwd; undefined → parent cwd. */
  cwd?: string;
  /** Parent session identity (file path + session ID). */
  parentSession?: ParentSessionInfo;
  /** Captures stable child identity before extension binding can fail. */
  onSessionCreated?: (identity: SubagentSessionIdentity) => void;
  /** Transfers a failed initialized session back to its invocation owner for close/checkpoint. */
  onInitializationFailed?: (session: SubagentSession) => void;
  model?: Model<any>;
  thinkingLevel?: ThinkingLevel;
  /** Already leased and strictly validated original manager; never starts a new session. */
  recovery?: { manager: SessionManagerLike; lease: SessionLease };
}

/**
 * Build a born-complete SubagentSession: assemble config, create the SDK
 * session, publish lifecycle events, bind extensions, apply the recursion guard.
 */
export async function createSubagentSession(
  params: CreateSubagentSessionParams,
  deps: SubagentSessionDeps,
): Promise<SubagentSession> {
  const { snapshot, type } = params;
  const parentSessionId = params.parentSession?.parentSessionId;
  let lease = params.recovery?.lease;
  let extensionWorkStarted = false;
  let subagentSession: SubagentSession | undefined;
  try {
  deps.lifecycle.spawning({ agentName: type, parentSessionId });

  // Resolve working directory upfront - needed for detectEnv before assembly.
  const effectiveCwd = params.cwd ?? snapshot.cwd;
  if (snapshot.projectTrusted !== undefined && !snapshot.promptOptions) {
    throw new Error("Parent structured system prompt is required for child initialization");
  }
  if (snapshot.promptOptions?.forceSystemPrompt !== undefined) {
    throw new Error("Cannot inherit an opaque forceSystemPrompt");
  }
  const sessionDir = deps.io.deriveSessionDir(params.parentSession?.parentSessionFile, effectiveCwd);
  const sessionManager = params.recovery?.manager ?? deps.io.createSessionManager(effectiveCwd, sessionDir);
  if (!params.recovery) sessionManager.newSession({ parentSession: params.parentSession?.parentSessionId });
  const sessionId = sessionManager.getSessionId();
  const outputFile = sessionManager.getSessionFile();
  lease ??= outputFile ? deps.io.acquireSessionLease?.(outputFile, sessionId) : undefined;
  const env = await deps.io.detectEnv(deps.exec, effectiveCwd);

  // Assemble session configuration (synchronous, no SDK objects).
  const cfg = assembleSessionConfig(
    type,
    {
      cwd: snapshot.cwd,
      parentSystemPrompt: snapshot.promptOptions ? "" : snapshot.systemPrompt,
      parentThinkingLevel: snapshot.thinkingLevel,
      parentModel: snapshot.model,
      modelRegistry: snapshot.modelRegistry,
    },
    {
      cwd: params.cwd,
      model: params.model,
      thinkingLevel: params.thinkingLevel,
    },
    env,
    deps.registry,
    deps.io.assemblerIO,
  );

  const agentDir = deps.io.getAgentDir();
  const projectTrusted = resolve(cfg.effectiveCwd) === resolve(snapshot.cwd)
    ? snapshot.projectTrusted === true
    : deps.io.getProjectTrust?.(cfg.effectiveCwd, agentDir) === true;
  const sessionSettings = deps.io.createSettingsManager(cfg.effectiveCwd, agentDir, projectTrusted);
  const loaderSettings = deps.io.createLoaderSettingsManager(sessionSettings);

  // Named built-ins retain the SDK's disabled/excluded extension policy. Parent
  // registered capabilities also prevent recreating built-ins suppressed by CLI.
  const extensionFactories = selectBuiltinExtensions(cfg.toolNames, { availableTools: snapshot.availableTools });
  let childAppendSources: string[] = [];
  if (snapshot.promptOptions) {
    extensionFactories.push(createPromptInheritanceExtension(snapshot.promptOptions, cfg.systemPrompt, agentDir, () => childAppendSources));
  }
  const loader = deps.io.createResourceLoader({
    cwd: cfg.effectiveCwd,
    agentDir,
    settingsManager: loaderSettings,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: !snapshot.promptOptions,
    extensionFactories,
    systemPromptOverride: () => snapshot.promptOptions ? snapshot.promptOptions.customPrompt : cfg.systemPrompt,
    appendSystemPromptOverride: (base = []) => {
      childAppendSources = [...base];
      return snapshot.promptOptions ? base : [];
    },
  });
  extensionWorkStarted = true;
  await loader.reload();
  if (snapshot.promptOptions) {
    inheritPromptOptions(snapshot.promptOptions, {
      cwd: cfg.effectiveCwd, appendSystemPrompt: childAppendSources.join("\n\n"),
    }, cfg.systemPrompt, agentDir, childAppendSources);
  }

  // The original manager is reused for recovery; its lease predates any extension work.
  const { session } = await deps.io.createSession({
    cwd: cfg.effectiveCwd,
    agentDir,
    sessionManager,
    settingsManager: sessionSettings,
    modelRegistry: snapshot.modelRegistry,
    model: cfg.model,
    tools: cfg.toolNames,
    excludeTools: EXCLUDED_TOOL_NAMES,
    resourceLoader: loader,
    thinkingLevel: cfg.thinkingLevel,
  });

  subagentSession = new SubagentSession(session, {
    outputFile,
    sessionId,
    sessionDir,
    agentName: type,
    parentContext: params.recovery ? undefined : snapshot.parentContext,
    lifecycle: deps.lifecycle,
    lease,
    checkpointManager: sessionManager.getCwd && sessionManager.getLeafId && sessionManager.appendCustomEntry
      ? sessionManager as SessionManagerLike & CheckpointManager : undefined,
  });

  params.onSessionCreated?.({ sessionId, outputFile });

  // Publish session-created before bindExtensions() so observers (e.g. the
  // permission system) can register the child synchronously and have their
  // entry in place for the first permission check during child extension
  // initialization. The event bus dispatches synchronously, so a synchronous
  // subscriber completes before this returns.
  deps.lifecycle.sessionCreated({ sessionId, parentSessionId });

  // Bind extensions so that session_start fires and extensions can initialize.
  await session.bindExtensions({});
    if (typeof session.getAllTools === "function") {
      // Late-bound tools such as codemode are registered inactive. Activate only
      // declared, actually registered names; the SDK's persistent denylist remains.
      const allowed = session.getAllTools().map((tool) => tool.name).filter((name) =>
        cfg.toolNames.some((pattern) => matchesTool(pattern, name)) && !EXCLUDED_TOOL_NAMES.includes(name),
      );
      assertDeclaredTools(cfg.toolNames, allowed);
      session.setActiveToolsByName(allowed);
      assertDeclaredTools(cfg.toolNames, [...new Set([...session.getActiveToolNames(), ...session.getCallableToolNames()])]);
    }
  return subagentSession;
  } catch (error) {
    if (subagentSession) {
      try { await subagentSession.dispose(); } catch { /* The owner must retain unconfirmed cleanup. */ }
      params.onInitializationFailed?.(subagentSession);
    } else if (!extensionWorkStarted) {
      try { lease?.release(); }
      catch (releaseError) {
        throw new AggregateError([error, releaseError], `${error instanceof Error ? error.message : String(error)}; ownership release failed at ${lease?.path}: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`);
      }
    }
    if (lease && extensionWorkStarted && (!subagentSession?.cleanupConfirmed || !params.onInitializationFailed)) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; initialization cleanup is unconfirmed, ownership retained at ${lease.path}`, { cause: error });
    }
    throw error;
  }
}
