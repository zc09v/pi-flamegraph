/**
 * Shared types for the pi-flamegraph package.
 */

/** Segment category. Each category maps to a color in the flame graph. */
export type SpanCategory = "session" | "agent" | "turn" | "model" | "request" | "tool";

/** A single timed segment in the session life cycle (a flame graph node). */
export interface Span {
  /** Human readable label shown in the flame graph. */
  name: string;
  category: SpanCategory;
  /** Epoch milliseconds when the segment started. */
  start: number;
  /** Epoch milliseconds when the segment ended. */
  end: number;
  children: Span[];
  /** Optional extra info surfaced in the hover tooltip. */
  meta?: Record<string, unknown>;
}

/** Top-level payload embedded in the generated HTML. */
export interface FlameGraphData {
  title: string;
  sessionId?: string;
  sessionFile?: string;
  cwd?: string;
  generatedAt: string;
  root: Span;
}
