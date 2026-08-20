import { parseObject } from "./parse.ts";
import {
  EMPTY_GRAPH,
  graphFromToolJson,
  graphIsEmpty,
  mergeGraphs,
  type GraphData,
} from "./graph-model.ts";

const OKF_TOOLS = new Set(["okf_search", "okf_get", "okf_coverage", "okf_graph", "okf_compare"]);

export type OkfGraphState = {
  turn: number;
  calls: ReadonlyMap<string, string>;
  graph: GraphData;
  anchorSeq: number;
};

type SessionEvent = {
  type: string;
  seq: number;
  surfaceOp?: string;
  data?: Record<string, unknown>;
};

type Match = {
  event: SessionEvent;
  location?: unknown;
};

type Context = {
  key: string;
  id: string;
  start?: Match;
  state?: OkfGraphState;
};

/** Duck-typed Conversation Node: one graph row per turn that used okf_* tools. */
export const okfGraphDefinition = {
  kind: "okf-graph",
  target: "chat",
  match(event: SessionEvent): { id: string; role: "start" | "update" } | null {
    const turn = turnOf(event);
    if (turn === undefined) {
      return null;
    }
    if (event.type === "turn/start") {
      return { id: String(turn), role: "start" };
    }
    if (event.type === "tool/call") {
      return { id: String(turn), role: "update" };
    }
    if (event.type === "tool/result" && event.surfaceOp === "append") {
      return { id: String(turn), role: "update" };
    }
    return null;
  },
  start(_context: Context, match: Match): OkfGraphState {
    if (match.event.type !== "turn/start") {
      throw new Error("okf-graph start requires turn/start");
    }
    return {
      turn: turnOf(match.event) ?? 0,
      calls: new Map(),
      graph: EMPTY_GRAPH,
      anchorSeq: match.event.seq,
    };
  },
  update(context: Context & { state: OkfGraphState }, match: Match): OkfGraphState {
    if (match.event.type === "tool/call") {
      const name = asString(match.event.data?.name);
      const callId = asString(match.event.data?.callId);
      if (!name || !callId || !OKF_TOOLS.has(name)) {
        return context.state;
      }
      const calls = new Map(context.state.calls);
      calls.set(callId, name);
      return { ...context.state, calls };
    }
    if (match.event.type !== "tool/result") {
      return context.state;
    }
    const result = toolResultOf(match.event);
    if (result === null || result.isError) {
      return context.state;
    }
    const name = context.state.calls.get(result.callId) ?? "";
    const body = parseObject(result.text);
    if (body === null) {
      return context.state;
    }
    const extra = graphFromToolJson(name, body);
    if (graphIsEmpty(extra)) {
      return context.state;
    }
    const graph = mergeGraphs(context.state.graph, extra);
    return {
      ...context.state,
      graph,
      anchorSeq: graphIsEmpty(context.state.graph) ? match.event.seq : context.state.anchorSeq,
    };
  },
  buildLocationData(context: Context, scope: string) {
    if (scope !== "turn" || context.state === undefined || graphIsEmpty(context.state.graph)) {
      return null;
    }
    return {
      kind: "turn",
      turn: context.state.turn,
      key: "okf-graph",
      value: context.state.graph,
    };
  },
  buildViewNode(context: Context) {
    if (context.start === undefined || context.state === undefined || graphIsEmpty(context.state.graph)) {
      return null;
    }
    return {
      key: context.key,
      kind: "okf-graph",
      id: context.id,
      target: "chat",
      anchorSeq: context.state.anchorSeq,
      location: context.start.location ?? { kind: "unresolved" },
      visibility: "visible",
      data: context.state.graph,
    };
  },
};

function turnOf(event: SessionEvent): number | undefined {
  const turn = event.data?.turn;
  if (typeof turn === "number" && Number.isFinite(turn)) {
    return turn;
  }
  return undefined;
}

function toolResultOf(event: SessionEvent): { callId: string; isError: boolean; text: string } | null {
  const message = event.data?.message as Record<string, unknown> | undefined;
  if (message === undefined) {
    return null;
  }
  const source = message.source as Record<string, unknown> | undefined;
  const callId = asString(source?.callId);
  const block = Array.isArray(message.content) ? message.content[0] as Record<string, unknown> | undefined : undefined;
  if (!callId || block === undefined) {
    return null;
  }
  const parts: string[] = [];
  const inner = Array.isArray(block.content) ? block.content : [block];
  for (const item of inner) {
    if (typeof item === "object" && item !== null && (item as { type?: string }).type === "text") {
      const text = (item as { text?: unknown }).text;
      if (typeof text === "string") {
        parts.push(text);
      }
    }
  }
  return { callId, isError: block.isError === true, text: parts.join("\n") };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
