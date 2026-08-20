const MAX_LEN = 80;

function baseSlug(title: string): string {
  return title
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{Letter}\p{Number}-]+/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function conceptSlug(title: string): string {
  const slug = baseSlug(title);
  if (!slug) {
    return "untitled";
  }
  return slug.length <= MAX_LEN ? slug : slug.slice(0, MAX_LEN).replace(/-$/, "");
}

export function slugify(year: string | number, title: string): string {
  const y = String(year);
  const slug = baseSlug(title);
  const combined = slug ? `${y}-${slug}` : y;
  if (combined.length <= MAX_LEN) {
    return combined;
  }
  return combined.slice(0, MAX_LEN).replace(/-$/, "");
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) {
    return false;
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

/** Year-only → YYYY-01-01. Invalid or impossible dates return undefined. */
export function normalizePublished(value: string): string | undefined {
  const v = value.trim();
  if (/^\d{4}$/.test(v)) {
    return `${v}-01-01`;
  }
  const ym = /^(\d{4})-(\d{2})$/.exec(v);
  if (ym) {
    const month = Number(ym[2]);
    if (month < 1 || month > 12) {
      return undefined;
    }
    return `${v}-01`;
  }
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (ymd) {
    if (isValidCalendarDate(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]))) {
      return v;
    }
    return undefined;
  }
  return undefined;
}

export function publishedYear(published: string): string | undefined {
  const m = published.match(/^(\d{4})/);
  return m?.[1];
}
