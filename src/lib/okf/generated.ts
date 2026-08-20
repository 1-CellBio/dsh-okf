/** Provenance `generated.by` prefix written by this library. */
export const OKF_GENERATOR = "okf";

export function generatedBy(suffix: string): string {
  return `${OKF_GENERATOR}/${suffix}`;
}
