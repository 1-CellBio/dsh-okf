export const THEME_STORAGE_KEY = "kg.theme";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function isThemePreference(value: string | null): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

export function readThemePreference(): ThemePreference {
  if (typeof localStorage === "undefined") {
    return "system";
  }
  const raw = localStorage.getItem(THEME_STORAGE_KEY);
  return isThemePreference(raw) ? raw : "system";
}

export function systemPrefersDark(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveTheme(preference: ThemePreference, prefersDark = systemPrefersDark()): ResolvedTheme {
  if (preference === "system") {
    return prefersDark ? "dark" : "light";
  }
  return preference;
}

export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference);
  if (typeof document === "undefined") {
    return resolved;
  }
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.style.colorScheme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute("content", resolved === "dark" ? "#252525" : "#ffffff");
  }
  return resolved;
}

export function persistTheme(preference: ThemePreference): void {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  }
  applyTheme(preference);
  emit();
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function applyStoredTheme(): ResolvedTheme {
  return applyTheme(readThemePreference());
}
