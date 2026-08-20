import { EMPTY_GRAPH, mergeGraphs, type GraphData } from "./graph-model.ts";

type SessionGraphs = Record<string, GraphData>;

/** Merges per-turn conversation graphs into one snapshot per session for the sidebar. */
export class SessionGraphLedger {
  private readonly sessions = new Map<string, Map<string, GraphData>>();
  /** Cached merged graph per session, so a single update only recomputes one session. */
  private readonly sessionGraphs = new Map<string, GraphData>();
  private readonly listeners = new Set<() => void>();
  private snapshot: SessionGraphs = {};

  observe(sessionId: string, key: string, graph: GraphData): void {
    let turns = this.sessions.get(sessionId);
    if (turns === undefined) {
      turns = new Map();
      this.sessions.set(sessionId, turns);
    }
    turns.set(key, graph);
    this.publishSession(sessionId);
  }

  forget(sessionId: string, key: string): void {
    const turns = this.sessions.get(sessionId);
    if (turns === undefined || !turns.delete(key)) {
      return;
    }
    if (turns.size === 0) {
      this.sessions.delete(sessionId);
      this.sessionGraphs.delete(sessionId);
      this.emit();
      return;
    }
    this.publishSession(sessionId);
  }

  bindStore(): {
    getSnapshot: () => SessionGraphs;
    subscribe: (listener: () => void) => () => void;
  } {
    return {
      getSnapshot: () => this.snapshot,
      subscribe: (listener) => {
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
        };
      },
    };
  }

  private publishSession(sessionId: string): void {
    const turns = this.sessions.get(sessionId);
    let graph = EMPTY_GRAPH;
    if (turns !== undefined) {
      for (const piece of turns.values()) {
        graph = mergeGraphs(graph, piece);
      }
    }
    this.sessionGraphs.set(sessionId, graph);
    this.emit();
  }

  private emit(): void {
    const next: SessionGraphs = {};
    for (const [sessionId, graph] of this.sessionGraphs) {
      next[sessionId] = graph;
    }
    this.snapshot = next;
    for (const listener of this.listeners) {
      listener();
    }
  }
}
