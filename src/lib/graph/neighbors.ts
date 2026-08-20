export type NeighborRef = {
  id: string;
  title: string;
  type: string;
};

export type NeighborLink = NeighborRef & {
  direction: "out" | "in" | "both";
};

const TYPE_ORDER = ["Paper", "Topic", "Method", "Entity", "Dataset", "Gene", "Pathway", "Claim"];

export function mergeNeighbors(outgoing: NeighborRef[], incoming: NeighborRef[]): NeighborLink[] {
  const map = new Map<string, NeighborLink>();
  for (const item of outgoing) {
    map.set(item.id, { ...item, direction: "out" });
  }
  for (const item of incoming) {
    const existing = map.get(item.id);
    if (existing) {
      existing.direction = "both";
    } else {
      map.set(item.id, { ...item, direction: "in" });
    }
  }
  return [...map.values()].sort((a, b) => {
    const typeDelta = typeRank(a.type) - typeRank(b.type);
    if (typeDelta !== 0) {
      return typeDelta;
    }
    return a.title.localeCompare(b.title);
  });
}

export function groupNeighbors(items: NeighborLink[]): { type: string; items: NeighborLink[] }[] {
  const groups = new Map<string, NeighborLink[]>();
  for (const item of items) {
    const list = groups.get(item.type) ?? [];
    list.push(item);
    groups.set(item.type, list);
  }
  return [...groups.entries()]
    .sort((a, b) => typeRank(a[0]) - typeRank(b[0]))
    .map(([type, grouped]) => ({ type, items: grouped }));
}

export function excerptBody(body: string, max = 160): string {
  const text = body
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#*_`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    return "";
  }
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max).trimEnd()}…`;
}

function typeRank(type: string): number {
  const index = TYPE_ORDER.indexOf(type);
  return index === -1 ? TYPE_ORDER.length : index;
}
