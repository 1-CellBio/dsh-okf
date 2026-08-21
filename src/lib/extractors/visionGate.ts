/**
 * Optional cost cap for vision="auto". When unset, every planned visual page
 * is transcribed (scans: all pages; born-digital: figure + thin-text pages).
 * Pass visionMaxPages on okf_ingest only when you want awaiting_vision instead
 * of finishing a long document.
 */
export const VISION_PAUSE_DEFAULT: number | undefined = undefined;
