import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import { libraryWorkbench } from "@/lib/library/workbench";
import { organizeWorkbench, readWorkbenchPage } from "@/lib/library/organize";
import { listCoverage } from "./okf-ops";
import { sessionCwd, type PluginPaths } from "./paths";
import { openSession } from "./session";
import type { PathSource } from "./settings";

type AgentsLookup = {
  get: (id: string) => { session?: { header?: { cwd?: string } } } | undefined;
};

type WebServerLookup = {
  register: (route: {
    kind: "exact";
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  }) => () => void;
};

type SessionStore = ReturnType<typeof openSession>["store"];

/** Same-origin snapshots for conversation subpages. Resolves cwd from the live session. */
export function installLibraryHttp(ctx: Context, getPaths: PathSource): void {
  ctx.inject(["webServer", "agents"], (inner) => {
    const webServer = (inner as Context & { webServer: WebServerLookup }).webServer;
    const agents = (inner as Context & { agents: AgentsLookup }).agents;
    const routes: Array<{ path: string; handle: (req: IncomingMessage, res: ServerResponse) => Promise<void> }> = [
      { path: "/okf/library", handle: (req, res) => handleLibrary(req, res, agents, getPaths) },
      { path: "/okf/organize", handle: (req, res) => handleOrganize(req, res, agents, getPaths) },
      { path: "/okf/coverage", handle: (req, res) => handleCoverage(req, res, agents, getPaths) },
      { path: "/okf/page", handle: (req, res) => handlePage(req, res, agents, getPaths) },
    ];
    for (const route of routes) {
      inner.effect(() =>
        webServer.register({
          kind: "exact",
          path: route.path,
          handler: (req, res) => {
            void route.handle(req, res);
          },
        }),
      );
    }
  });
}

async function handleLibrary(
  req: IncomingMessage,
  res: ServerResponse,
  agents: AgentsLookup,
  getPaths: PathSource,
): Promise<void> {
  try {
    const { url, store } = openFromRequest(req, agents, getPaths);
    const includeClaims = url.searchParams.get("claims") === "1";
    const minRaw = Number(url.searchParams.get("minDegree") ?? "0");
    const claimMinDegree = Number.isFinite(minRaw) ? Math.max(0, Math.min(12, Math.floor(minRaw))) : 0;
    // Node cap is user-controlled. Absent/empty keeps the server default;
    // 0 means "no cap" (all nodes); positive values are clamped for safety.
    const rawMax = url.searchParams.get("maxNodes") ?? "";
    let maxNodes: number | undefined;
    if (rawMax.trim() !== "") {
      const parsed = Number(rawMax);
      if (Number.isFinite(parsed)) {
        maxNodes = parsed <= 0 ? Infinity : Math.min(20000, Math.floor(parsed));
      }
    }
    json(res, 200, await libraryWorkbench(store, {
      includeClaims,
      claimMinDegree: includeClaims ? claimMinDegree : 0,
      ...(maxNodes !== undefined ? { maxNodes } : {}),
    }));
  } catch (error) {
    fail(res, error);
  }
}

async function handleOrganize(
  req: IncomingMessage,
  res: ServerResponse,
  agents: AgentsLookup,
  getPaths: PathSource,
): Promise<void> {
  try {
    const { store } = openFromRequest(req, agents, getPaths);
    json(res, 200, await organizeWorkbench(store));
  } catch (error) {
    fail(res, error);
  }
}

async function handleCoverage(
  req: IncomingMessage,
  res: ServerResponse,
  agents: AgentsLookup,
  getPaths: PathSource,
): Promise<void> {
  try {
    const { url, store } = openFromRequest(req, agents, getPaths);
    json(res, 200, await listCoverage(store, {
      topic: url.searchParams.get("topic")?.trim() || undefined,
      from: url.searchParams.get("from")?.trim() || undefined,
      to: url.searchParams.get("to")?.trim() || undefined,
    }));
  } catch (error) {
    fail(res, error);
  }
}

async function handlePage(
  req: IncomingMessage,
  res: ServerResponse,
  agents: AgentsLookup,
  getPaths: PathSource,
): Promise<void> {
  try {
    const { url, store } = openFromRequest(req, agents, getPaths);
    const id = url.searchParams.get("id")?.trim() ?? "";
    json(res, 200, await readWorkbenchPage(store, id));
  } catch (error) {
    fail(res, error);
  }
}

function openFromRequest(
  req: IncomingMessage,
  agents: AgentsLookup,
  getPaths: PathSource,
): { url: URL; store: SessionStore } {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const sessionId = url.searchParams.get("session")?.trim() ?? "";
  if (!sessionId) {
    throw Object.assign(new Error("session is required"), { status: 400 });
  }
  const agent = agents.get(sessionId);
  const cwd = sessionCwd({ agent: agent ? { session: agent.session } : undefined });
  if (!cwd) {
    throw Object.assign(new Error("session has no workspace"), { status: 404 });
  }
  const paths: PluginPaths = getPaths(cwd);
  return { url, store: openSession(paths.okfDir).store };
}

function fail(res: ServerResponse, error: unknown): void {
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status: unknown }).status)
    : 500;
  const code = Number.isFinite(status) && status >= 400 ? status : 500;
  json(res, code, { error: error instanceof Error ? error.message : String(error) });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(payload);
}
