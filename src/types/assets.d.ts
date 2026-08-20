// Vite-style `?url` asset imports are only used by browser-only modules
// (workerSrc.ts / sqlBrowser.ts) that the plugin node bundle never reaches.
// This ambient declaration keeps standalone `tsc` clean without pulling in Vite.
declare module "*?url" {
  const src: string;
  export default src;
}
