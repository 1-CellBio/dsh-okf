import type { ChatMode } from "@/lib/agent/types";

export const CHAT_SESSIONS_KEY = "kg.chat.sessions";
export const DEFAULT_SESSION_TITLE = "新对话";
export const MAX_SESSIONS_PER_WORKSPACE = 40;

export type ChatTurn = {
  role: "user" | "assistant";
  content: string;
};

export type ChatSession = {
  id: string;
  title: string;
  mode: ChatMode;
  turns: ChatTurn[];
  createdAt: string;
  updatedAt: string;
};

export type ChatWorkspaceState = {
  workspaceId: string;
  activeId: string;
  sessions: ChatSession[];
};

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

const cache = new Map<string, ChatWorkspaceState>();
const listeners = new Set<() => void>();
let fallbackStorage = memoryStorage();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function memoryStorage(): StorageLike {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

function hasBrowserStorage(): boolean {
  try {
    return typeof localStorage !== "undefined" && typeof localStorage.getItem === "function";
  } catch {
    return false;
  }
}

function browserStorage(): StorageLike {
  return hasBrowserStorage() ? localStorage : fallbackStorage;
}

export function sessionTitleFromTurns(turns: ChatTurn[]): string {
  const first = turns.find((turn) => turn.role === "user")?.content.trim();
  if (!first) {
    return DEFAULT_SESSION_TITLE;
  }
  const oneLine = first.replace(/\s+/gu, " ");
  return oneLine.length > 36 ? `${oneLine.slice(0, 36)}…` : oneLine;
}

export function formatSessionTime(iso: string, now = Date.now()): string {
  const stamp = Date.parse(iso);
  if (Number.isNaN(stamp)) {
    return "";
  }
  const diff = now - stamp;
  if (diff < 60_000) {
    return "刚刚";
  }
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)} 分钟前`;
  }
  if (diff < 86_400_000) {
    return `${Math.floor(diff / 3_600_000)} 小时前`;
  }
  return new Date(stamp).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export function createSession(now = new Date(), id = crypto.randomUUID()): ChatSession {
  const iso = now.toISOString();
  return {
    id,
    title: DEFAULT_SESSION_TITLE,
    mode: "ask",
    turns: [],
    createdAt: iso,
    updatedAt: iso,
  };
}

export function emptyWorkspace(workspaceId: string, now = new Date()): ChatWorkspaceState {
  const session = createSession(now);
  return { workspaceId, activeId: session.id, sessions: [session] };
}

function isTurn(value: unknown): value is ChatTurn {
  if (!value || typeof value !== "object") {
    return false;
  }
  const turn = value as ChatTurn;
  return (turn.role === "user" || turn.role === "assistant") && typeof turn.content === "string";
}

function isSession(value: unknown): value is ChatSession {
  if (!value || typeof value !== "object") {
    return false;
  }
  const session = value as ChatSession;
  return (
    typeof session.id === "string" &&
    typeof session.title === "string" &&
    typeof session.mode === "string" &&
    typeof session.createdAt === "string" &&
    typeof session.updatedAt === "string" &&
    Array.isArray(session.turns) &&
    session.turns.every(isTurn)
  );
}

export function parseWorkspace(raw: unknown, workspaceId: string): ChatWorkspaceState | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const workspaces = record.workspaces;
  const entry =
    workspaces && typeof workspaces === "object"
      ? (workspaces as Record<string, unknown>)[workspaceId]
      : undefined;
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  const parsed = entry as Partial<ChatWorkspaceState>;
  if (!Array.isArray(parsed.sessions) || parsed.sessions.length === 0 || !parsed.sessions.every(isSession)) {
    return undefined;
  }
  const activeId =
    typeof parsed.activeId === "string" && parsed.sessions.some((session) => session.id === parsed.activeId)
      ? parsed.activeId
      : parsed.sessions[0].id;
  return { workspaceId, activeId, sessions: parsed.sessions };
}

function readAll(storage: StorageLike): Record<string, unknown> {
  const raw = storage.getItem(CHAT_SESSIONS_KEY);
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function loadWorkspace(workspaceId: string, storage: StorageLike = browserStorage()): ChatWorkspaceState {
  const parsed = parseWorkspace(readAll(storage), workspaceId);
  return parsed ?? emptyWorkspace(workspaceId);
}

export function saveWorkspace(state: ChatWorkspaceState, storage: StorageLike = browserStorage()): void {
  const all = readAll(storage);
  const workspaces =
    all.workspaces && typeof all.workspaces === "object"
      ? { ...(all.workspaces as Record<string, unknown>) }
      : {};
  workspaces[state.workspaceId] = {
    activeId: state.activeId,
    sessions: state.sessions,
  };
  storage.setItem(CHAT_SESSIONS_KEY, JSON.stringify({ workspaces }));
}

export function pruneSessions(sessions: ChatSession[], keepId: string): ChatSession[] {
  let next = sessions;
  while (next.length > MAX_SESSIONS_PER_WORKSPACE) {
    const ranked = [...next].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    const drop =
      ranked.find((session) => session.id !== keepId && session.turns.length === 0) ??
      ranked.find((session) => session.id !== keepId);
    if (!drop) {
      break;
    }
    next = next.filter((session) => session.id !== drop.id);
  }
  return next;
}

export function activeSession(state: ChatWorkspaceState): ChatSession {
  return state.sessions.find((session) => session.id === state.activeId) ?? state.sessions[0];
}

export function patchSessionById(
  state: ChatWorkspaceState,
  id: string,
  patch: Partial<Pick<ChatSession, "mode" | "turns" | "title">>,
  now = new Date(),
): ChatWorkspaceState {
  const current = state.sessions.find((session) => session.id === id);
  if (!current) {
    return state;
  }
  const turns = patch.turns ?? current.turns;
  const next: ChatSession = {
    ...current,
    ...patch,
    title: patch.title ?? (turns.length > 0 ? sessionTitleFromTurns(turns) : current.title),
    turns,
    updatedAt: now.toISOString(),
  };
  return {
    ...state,
    sessions: state.sessions.map((session) => (session.id === id ? next : session)),
  };
}

export function patchActiveSession(
  state: ChatWorkspaceState,
  patch: Partial<Pick<ChatSession, "mode" | "turns" | "title">>,
  now = new Date(),
): ChatWorkspaceState {
  return patchSessionById(state, activeSession(state).id, patch, now);
}

export function startSession(state: ChatWorkspaceState, now = new Date()): ChatWorkspaceState {
  const current = activeSession(state);
  if (current.turns.length === 0) {
    return state;
  }
  const session = createSession(now);
  return {
    workspaceId: state.workspaceId,
    activeId: session.id,
    sessions: pruneSessions([session, ...state.sessions], session.id),
  };
}

export function activateSession(state: ChatWorkspaceState, id: string): ChatWorkspaceState {
  if (!state.sessions.some((session) => session.id === id)) {
    return state;
  }
  return { ...state, activeId: id };
}

export function deleteSession(state: ChatWorkspaceState, id: string, now = new Date()): ChatWorkspaceState {
  const remaining = state.sessions.filter((session) => session.id !== id);
  if (remaining.length === 0) {
    return emptyWorkspace(state.workspaceId, now);
  }
  return {
    workspaceId: state.workspaceId,
    activeId: state.activeId === id ? remaining[0].id : state.activeId,
    sessions: remaining,
  };
}

export function getWorkspace(workspaceId: string): ChatWorkspaceState {
  const hit = cache.get(workspaceId);
  if (hit) {
    return hit;
  }
  const loaded = loadWorkspace(workspaceId);
  cache.set(workspaceId, loaded);
  return loaded;
}

export function writeWorkspace(state: ChatWorkspaceState): ChatWorkspaceState {
  cache.set(state.workspaceId, state);
  saveWorkspace(state);
  emit();
  return state;
}

export function subscribeSessions(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetSessionCache(): void {
  cache.clear();
}

export function resetSessionStoreForTests(): void {
  cache.clear();
  fallbackStorage = memoryStorage();
  if (hasBrowserStorage()) {
    localStorage.removeItem(CHAT_SESSIONS_KEY);
  }
}
