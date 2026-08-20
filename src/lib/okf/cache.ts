/** Rebuildable indexes and pipeline state. Not knowledge; packs omit this tree. */
export const OKF_CACHE_DIR = ".okf";
/** Pre-rename cache folder. Still excluded from packs and reads if present. */
export const LEGACY_OKF_CACHE_DIR = ".knowledgegraph";

export function okfCachePath(file: string): string {
  const name = file.replace(/^\/+/, "");
  return `${OKF_CACHE_DIR}/${name}`;
}

export function isOkfCachePath(path: string): boolean {
  const normalized = path.replace(/^\/+/, "");
  return (
    normalized === OKF_CACHE_DIR ||
    normalized.startsWith(`${OKF_CACHE_DIR}/`) ||
    normalized === LEGACY_OKF_CACHE_DIR ||
    normalized.startsWith(`${LEGACY_OKF_CACHE_DIR}/`)
  );
}

export function gitignoreOkfCache(): string {
  return `${OKF_CACHE_DIR}/\n${LEGACY_OKF_CACHE_DIR}/\n`;
}
