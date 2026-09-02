/**
 * pi-flamegraph extension
 *
 * Records the wall-clock life cycle of a pi session (agent runs → turns →
 * model generation → tool executions) as nested timed spans, and renders an
 * interactive flame graph to a self-contained HTML file.
 *
 * Usage:
 *   /flamegraph [output.html]     render now (default: ./flamegraph.html)
 *   generate_flamegraph tool      render now via the agent
 *
 * A snapshot is also saved automatically when the session shuts down under
 * ~/.pi/agent/flamegraph/<session-id>.html + .json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderFlameGraphHtml } from "./renderer";
import type { FlameGraphData, Span, SpanCategory } from "./types";

interface AssistantLike {
  provider?: string;
  model?: string;
}

interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
}

/** Rich assistant message shape used by message_start/message_end handlers. */
interface AssistantMessageLike extends AssistantLike {
  role?: string;
  usage?: UsageLike;
  stopReason?: string;
  responseModel?: string;
  responseId?: string;
  errorMessage?: string;
  content?: unknown;
}

export default function flameGraphExtension(pi: ExtensionAPI) {
  // Per-session state. The extension instance is rebound for each session, so
  // these are safe to keep in the factory closure.
  let root: Span | null = null;
  let sessionSpan: Span | null = null;
  let agentSpan: Span | null = null;
  let turnSpan: Span | null = null;
  let assistantSpan: Span | null = null;
  const requestStack: Span[] = [];
  const openTools = new Map<string, Span>();
  const openSet = new Set<Span>();

  let sessionId: string | undefined;
  let sessionFile: string | undefined;
  let cwd: string | undefined;
  let agentCount = 0;
  let turnCount = 0;
  let pendingPrompt: string | undefined;

  const snapDir = join(getAgentDir(), "flamegraph");

  function newSpan(
    name: string,
    category: SpanCategory,
    parent: Span | undefined,
    meta?: Record<string, unknown>,
  ): Span {
    const now = Date.now();
    const span: Span = { name, category, start: now, end: now, children: [], meta };
    if (parent) parent.children.push(span);
    openSet.add(span);
    return span;
  }

  function closeSpan(span: Span): void {
    span.end = Date.now();
    openSet.delete(span);
  }

  function ensureRoot(): Span {
    if (!root) {
      root = newSpan("session", "session", undefined);
      sessionSpan = root;
    }
    return root;
  }

  /** Deep-clone the live tree; currently-open spans are closed at "now" without mutating live state. */
  function snapshotRoot(): Span {
    const now = Date.now();
    const clone = (src: Span): Span => {
      const out: Span = {
        name: src.name,
        category: src.category,
        start: src.start,
        end: openSet.has(src) ? now : src.end,
        children: [],
        meta: src.meta ? { ...src.meta } : undefined,
      };
      for (const child of src.children) out.children.push(clone(child));
      return out;
    };
    if (!root) ensureRoot();
    return clone(root!);
  }

  function buildData(): FlameGraphData | null {
    if (!root) return null;
    return {
      title: "pi session flame graph",
      sessionId,
      sessionFile,
      cwd,
      generatedAt: new Date().toISOString(),
      root: snapshotRoot(),
    };
  }

  function countAll(node: Span): number {
    let count = 1;
    for (const child of node.children) count += countAll(child);
    return count;
  }

  function countCategory(node: Span, category: SpanCategory): number {
    let count = node.category === category ? 1 : 0;
    for (const child of node.children) count += countCategory(child, category);
    return count;
  }

  function snapshotFileName(): string {
    return sessionId && sessionId.length > 0 ? sessionId : `session-${Date.now()}`;
  }

  function saveSnapshot(data: FlameGraphData): void {
    mkdirSync(snapDir, { recursive: true });
    const base = join(snapDir, snapshotFileName());
    writeFileSync(`${base}.json`, JSON.stringify(data, null, 2), "utf8");
    writeFileSync(`${base}.html`, renderFlameGraphHtml(data), "utf8");
  }

  function loadSnapshot(id: string): FlameGraphData | null {
    try {
      const file = join(snapDir, `${id}.json`);
      if (!existsSync(file)) return null;
      const parsed = JSON.parse(readFileSync(file, "utf8")) as FlameGraphData;
      return parsed?.root ? parsed : null;
    } catch {
      return null;
    }
  }

  function resolveOutputPath(arg: string, baseCwd: string): string {
    const trimmed = arg.trim();
    if (!trimmed) return join(baseCwd, "flamegraph.html");
    return isAbsolute(trimmed) ? trimmed : resolve(baseCwd, trimmed);
  }

  function notify(
    ctx: Pick<ExtensionContext, "hasUI" | "ui">,
    message: string,
    level: "info" | "warning" | "error" = "info",
  ): void {
    if (ctx.hasUI) ctx.ui.notify(message, level);
    else console.log(`[pi-flamegraph] ${message}`);
  }

  function summarizeArgs(args: unknown, max = 300): string | undefined {
    if (args == null) return undefined;
    let text: string;
    try {
      text = typeof args === "string" ? args : JSON.stringify(args);
    } catch {
      return undefined;
    }
    if (text.length > max) text = text.slice(0, max) + "…";
    return text;
  }

  function toolLabel(toolName: string, args: unknown): string {
    const summary = summarizeArgs(args, 60);
    return summary ? `${toolName}: ${summary}` : toolName;
  }

  function assistantLabel(message: AssistantLike): string {
    const provider = message.provider ?? "model";
    const model = message.model;
    return model ? `assistant · ${provider}/${model}` : `assistant · ${provider}`;
  }

  /** Total visible-text length of an assistant or tool-result content array. */
  function textChars(content: unknown): number | undefined {
    if (typeof content === "string") return content.length;
    if (Array.isArray(content)) {
      let total = 0;
      let found = false;
      for (const part of content) {
        if (part && typeof part === "object" && typeof (part as { text?: string }).text === "string") {
          total += (part as { text: string }).text.length;
          found = true;
        }
      }
      return found ? total : undefined;
    }
    return undefined;
  }

  /** Join the visible text parts of an assistant/tool message content array. */
  function textOf(content: unknown): string | undefined {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const part of content) {
        if (part && typeof part === "object" && typeof (part as { text?: string }).text === "string") {
          parts.push((part as { text: string }).text);
        }
      }
      return parts.length > 0 ? parts.join(" ") : undefined;
    }
    return undefined;
  }

  /** Collapse whitespace and truncate to a short, single-line preview. */
  function previewText(text: string | undefined, max: number): string | undefined {
    if (!text) return undefined;
    const t = text.replace(/\s+/g, " ").trim();
    if (!t) return undefined;
    return t.length > max ? t.slice(0, max) + "…" : t;
  }

  /** Compact token + cost summary from a provider usage object. */
  function usageMeta(usage: UsageLike | undefined): { tokens?: Record<string, number>; cost?: Record<string, number> } {
    if (!usage) return {};
    const tokens: Record<string, number> = {};
    if (typeof usage.input === "number") tokens.input = usage.input;
    if (typeof usage.output === "number") tokens.output = usage.output;
    if (typeof usage.cacheRead === "number") tokens.cacheRead = usage.cacheRead;
    if (typeof usage.cacheWrite === "number") tokens.cacheWrite = usage.cacheWrite;
    if (typeof usage.reasoning === "number") tokens.reasoning = usage.reasoning;
    if (typeof usage.totalTokens === "number") tokens.total = usage.totalTokens;
    const cost: Record<string, number> = {};
    if (usage.cost) {
      if (typeof usage.cost.input === "number") cost.input = usage.cost.input;
      if (typeof usage.cost.output === "number") cost.output = usage.cost.output;
      if (typeof usage.cost.cacheRead === "number") cost.cacheRead = usage.cost.cacheRead;
      if (typeof usage.cost.cacheWrite === "number") cost.cacheWrite = usage.cost.cacheWrite;
      if (typeof usage.cost.total === "number") cost.total = usage.cost.total;
    }
    const out: { tokens?: Record<string, number>; cost?: Record<string, number> } = {};
    if (Object.keys(tokens).length > 0) out.tokens = tokens;
    if (Object.keys(cost).length > 0) out.cost = cost;
    return out;
  }

  /** Curated subset of response headers to surface on a request span. */
  function requestMeta(status: number, headers: Record<string, string>): Record<string, unknown> {
    const meta: Record<string, unknown> = { status };
    const pick = (headerKey: string, metaKey: string): void => {
      const value = headers?.[headerKey];
      if (value !== undefined) meta[metaKey] = value;
    };
    pick("retry-after", "retryAfter");
    pick("x-ratelimit-remaining", "ratelimitRemaining");
    pick("x-ratelimit-limit", "ratelimitLimit");
    pick("x-ratelimit-reset", "ratelimitReset");
    pick("x-request-id", "requestId");
    pick("request-id", "requestId");
    pick("x-model", "responseModel");
    return meta;
  }

  /** Serialized-size summary for a tool result. */
  function resultChars(result: unknown): number | undefined {
    if (result == null) return undefined;
    if (typeof result === "object") {
      const content = (result as { content?: unknown }).content;
      if (content !== undefined) {
        const chars = textChars(content);
        if (chars !== undefined) return chars;
      }
    }
    if (typeof result === "string") return result.length;
    try {
      return JSON.stringify(result).length;
    } catch {
      return undefined;
    }
  }

  function writeFlameGraph(outputPath: string): { path: string; spanCount: number } {
    const data = buildData();
    if (!data) throw new Error("No session data recorded yet");
    const spanCount = countAll(data.root);
    if (spanCount <= 1) throw new Error("No activity recorded yet — run some turns first");
    writeFileSync(outputPath, renderFlameGraphHtml(data), "utf8");
    saveSnapshot(data);
    return { path: outputPath, spanCount };
  }

  // ----------------------------------------------------------------------
  // Lifecycle recording
  // ----------------------------------------------------------------------

  pi.on("session_start", (event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
    cwd = ctx.cwd;

    // Reset per-session accumulators.
    agentSpan = null;
    turnSpan = null;
    assistantSpan = null;
    requestStack.length = 0;
    openTools.clear();
    openSet.clear();
    pendingPrompt = undefined;

    const restored = sessionId ? loadSnapshot(sessionId) : null;
    if (restored?.root) {
      root = restored.root;
      sessionSpan = root;
      root.meta = { ...(root.meta ?? {}), reason: event.reason };
      openSet.add(root);
      agentCount = countCategory(root, "agent");
      turnCount = countCategory(root, "turn");
    } else {
      root = newSpan("session", "session", undefined, { reason: event.reason });
      sessionSpan = root;
      agentCount = 0;
      turnCount = 0;
    }
  });

  pi.on("before_agent_start", (event) => {
    pendingPrompt = event.prompt;
  });

  pi.on("agent_start", () => {
    const parent = sessionSpan ?? ensureRoot();
    agentCount += 1;
    const promptPreview = previewText(pendingPrompt, 60);
    const meta: Record<string, unknown> = {};
    if (pendingPrompt) meta.prompt = previewText(pendingPrompt, 400);
    agentSpan = newSpan(
      `agent run ${agentCount}${promptPreview ? ` · "${promptPreview}"` : ""}`,
      "agent",
      parent,
      Object.keys(meta).length > 0 ? meta : undefined,
    );
    pendingPrompt = undefined;
    turnSpan = null;
    assistantSpan = null;
    requestStack.length = 0;
  });

  pi.on("agent_end", (event) => {
    if (assistantSpan) {
      closeSpan(assistantSpan);
      assistantSpan = null;
    }
    while (requestStack.length) closeSpan(requestStack.pop()!);
    if (turnSpan) {
      closeSpan(turnSpan);
      turnSpan = null;
    }
    if (agentSpan) {
      agentSpan.meta = { ...(agentSpan.meta ?? {}), messages: event.messages.length };
      closeSpan(agentSpan);
      agentSpan = null;
    }
  });

  pi.on("turn_start", (event) => {
    const parent = agentSpan ?? sessionSpan ?? ensureRoot();
    turnCount += 1;
    turnSpan = newSpan(`turn ${turnCount}`, "turn", parent, { turnIndex: event.turnIndex });
    assistantSpan = null;
    requestStack.length = 0;
  });

  pi.on("turn_end", (event) => {
    if (assistantSpan) {
      closeSpan(assistantSpan);
      assistantSpan = null;
    }
    while (requestStack.length) closeSpan(requestStack.pop()!);
    if (turnSpan) {
      const meta: Record<string, unknown> = { ...(turnSpan.meta ?? {}) };
      meta.toolCalls = event.toolResults.length;
      const chars = textChars((event.message as { content?: unknown } | undefined)?.content);
      if (chars !== undefined) meta.textChars = chars;
      const toolNames = Array.from(new Set(event.toolResults.map((t) => t.toolName)));
      if (toolNames.length > 0) meta.tools = toolNames;
      turnSpan.meta = meta;
      closeSpan(turnSpan);
      turnSpan = null;
    }
  });

  pi.on("message_start", (event) => {
    const message = event.message as AssistantMessageLike | undefined;
    if (!message || message.role !== "assistant") return;
    const parent = turnSpan ?? agentSpan ?? sessionSpan ?? ensureRoot();
    const meta: Record<string, unknown> = { provider: message.provider, model: message.model };
    assistantSpan = newSpan(assistantLabel(message), "model", parent, meta);
  });

  pi.on("message_end", (event) => {
    const message = event.message as AssistantMessageLike | undefined;
    if (!message || message.role !== "assistant") return;
    if (assistantSpan) {
      const meta: Record<string, unknown> = { ...(assistantSpan.meta ?? {}) };
      Object.assign(meta, usageMeta(message.usage));
      if (message.stopReason) meta.stopReason = message.stopReason;
      if (message.responseModel) meta.responseModel = message.responseModel;
      if (message.responseId) meta.responseId = message.responseId;
      if (message.errorMessage) meta.errorMessage = message.errorMessage;
      const chars = textChars(message.content);
      if (chars !== undefined) meta.textChars = chars;
      const text = textOf(message.content);
      if (text) {
        meta.preview = previewText(text, 200);
        assistantSpan.name = `${assistantSpan.name} · "${previewText(text, 40)}"`;
      }
      assistantSpan.meta = meta;
      closeSpan(assistantSpan);
      assistantSpan = null;
    }
  });

  pi.on("before_provider_request", () => {
    const parent = assistantSpan ?? turnSpan ?? agentSpan ?? sessionSpan ?? ensureRoot();
    requestStack.push(newSpan("request", "request", parent));
  });

  pi.on("after_provider_response", (event) => {
    const span = requestStack.pop();
    if (!span) return;
    span.meta = requestMeta(event.status, event.headers);
    span.name = `request · ${event.status}`;
    closeSpan(span);
  });

  pi.on("tool_execution_start", (event) => {
    const parent = turnSpan ?? agentSpan ?? sessionSpan ?? ensureRoot();
    const span = newSpan(
      toolLabel(event.toolName, event.args),
      "tool",
      parent,
      { toolName: event.toolName, args: summarizeArgs(event.args, 300) },
    );
    openTools.set(event.toolCallId, span);
  });

  pi.on("tool_execution_end", (event) => {
    const span = openTools.get(event.toolCallId);
    if (!span) return;
    closeSpan(span);
    if (span.meta) {
      span.meta.isError = event.isError;
      const chars = resultChars(event.result);
      if (chars !== undefined) span.meta.resultChars = chars;
    }
    openTools.delete(event.toolCallId);
  });

  pi.on("session_shutdown", () => {
    try {
      if (assistantSpan) {
        closeSpan(assistantSpan);
        assistantSpan = null;
      }
      while (requestStack.length) closeSpan(requestStack.pop()!);
      if (turnSpan) {
        closeSpan(turnSpan);
        turnSpan = null;
      }
      if (agentSpan) {
        closeSpan(agentSpan);
        agentSpan = null;
      }
      for (const span of openTools.values()) closeSpan(span);
      openTools.clear();

      const now = Date.now();
      for (const span of openSet) span.end = now;
      openSet.clear();

      const data = buildData();
      if (data) saveSnapshot(data);
    } catch (error) {
      console.error("[pi-flamegraph] failed to save snapshot:", error);
    }
  });

  // ----------------------------------------------------------------------
  // User-facing entry points
  // ----------------------------------------------------------------------

  pi.registerCommand("flamegraph", {
    description: "Render an interactive flame graph of this session to an HTML file",
    handler: async (args, ctx) => {
      if (!root) {
        notify(ctx, "No session data recorded yet", "warning");
        return;
      }
      const outputPath = resolveOutputPath(args, ctx.cwd);
      try {
        const result = writeFlameGraph(outputPath);
        notify(ctx, `Flame graph written to ${result.path} (${result.spanCount} spans)`, "info");
      } catch (error) {
        notify(ctx, `Flame graph failed: ${(error as Error).message}`, "error");
      }
    },
  });

  pi.registerTool({
    name: "generate_flamegraph",
    label: "Generate Flame Graph",
    description:
      "Generate an interactive HTML flame graph of the current session life cycle (agent runs, turns, model generation, and tool execution timing). Returns the output file path.",
    parameters: Type.Object({
      outputPath: Type.Optional(
        Type.String({
          description: "Output HTML file path. Defaults to flamegraph.html in the working directory.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const outputPath = resolveOutputPath(params.outputPath ?? "", ctx.cwd);
        const result = writeFlameGraph(outputPath);
        return {
          content: [
            {
              type: "text" as const,
              text: `Flame graph written to ${result.path} (${result.spanCount} spans).`,
            },
          ],
          details: { outputPath: result.path, spanCount: result.spanCount },
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to generate flame graph: ${(error as Error).message}` }],
          details: { error: (error as Error).message },
        };
      }
    },
  });
}
