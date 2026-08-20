import { CoverageRow } from "./CoverageRow.tsx";
import { HelpRow } from "./HelpRow.tsx";
import { GraphNodeView } from "./GraphNodeView.tsx";
import { GraphView } from "./GraphView.tsx";
import { PathsCard } from "./PathsCard.tsx";
import { okfGraphDefinition } from "./okf-graph-definition.ts";
import { PathsCardController } from "./paths-card-controller.ts";
import type { PathSettingsScope } from "./paths-form.ts";
import { SearchRow } from "./SearchRow.tsx";
import { SessionGraphLedger } from "./session-graph-store.ts";
import type { GraphData } from "./graph-model.ts";
import { NS, en, zh } from "./locales.ts";

/**
 * Cordis fiber inject: slots + locale for toolviews; settingsScope.bind uses
 * the caller context for connection/remote; conversationEvents owns the graph Node.
 */
export const inject = [
  "slots",
  "locale",
  "settingsScope",
  "connection",
  "remote",
  "conversationEvents",
];

type ClientApplyContext = {
  slots: {
    inject: (name: string, factory: () => Generator<unknown, void, unknown> | unknown) => void;
    register: (spec: Record<string, unknown>, component: unknown) => unknown;
  };
  locale: {
    register: (ns: string, dicts: { zh: Record<string, string>; en: Record<string, string> }) => () => void;
    bind: (ns: string) => (key: string) => string;
  };
  settingsScope: {
    bind: (spec: { namespace: string }) => PathSettingsScope;
  };
  conversationEvents: {
    register: (definition: typeof okfGraphDefinition) => unknown;
  };
  effect: (fn: () => (() => void) | void, label?: string) => void;
};

/**
 * Browser half: keyed toolviews, Settings path card, Conversation Node graph,
 * and a session-body graph tab beside chat / trajectory.
 */
export function apply(ctx: ClientApplyContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-okf: dictionaries");
  ctx.conversationEvents.register(okfGraphDefinition);
  const t = ctx.locale.bind(NS);
  const ledger = new SessionGraphLedger();
  const observeGraph = (sessionId: string, key: string, graph: GraphData) => {
    ledger.observe(sessionId, key, graph);
  };
  const forgetGraph = (sessionId: string, key: string) => {
    ledger.forget(sessionId, key);
  };

  ctx.slots.inject("tool.call.toolview", function* () {
    yield ctx.slots.register(
      { name: "tool.call.toolview", key: "okf_search", locale: NS },
      SearchRow,
    );
    yield ctx.slots.register(
      { name: "tool.call.toolview", key: "okf_coverage", locale: NS },
      CoverageRow,
    );
    yield ctx.slots.register(
      { name: "tool.call.toolview", key: "okf_help", locale: NS },
      HelpRow,
    );
  });

  const paths = new PathsCardController(ctx.settingsScope.bind({ namespace: NS }));
  ctx.slots.inject("settings.plugin.item", function* () {
    yield ctx.slots.register(
      {
        name: "settings.plugin.item",
        key: NS,
        order: 30,
        locale: NS,
        inject: () => paths.inject(),
      },
      PathsCard,
    );
  });

  ctx.slots.inject("conversation.chat.node", () => ctx.slots.register(
    {
      name: "conversation.chat.node",
      key: "okf-graph",
      locale: NS,
      inject: () => ({ observeGraph, forgetGraph }),
    },
    GraphNodeView,
  ));

  ctx.slots.inject("conversation.view", () => ctx.slots.register(
    {
      name: "conversation.view",
      id: "okf",
      order: 20,
      locale: NS,
      label: () => t("graph.title"),
    },
    GraphView,
  ));
}
