/** GitHub rejects a check run whose output.summary exceeds 65,535 characters. */
export const SUMMARY_LIMIT = 65_000;

/** Cuts by UTF-8 bytes, which stays under the limit however GitHub counts characters. */
export function capSummary(markdown: string): string {
  const bytes = new TextEncoder().encode(markdown);
  if (bytes.length <= SUMMARY_LIMIT) return markdown;
  const note = "\n\n(Cut to fit the check run; the job's step summary has the full table.)";
  const kept = new TextDecoder().decode(bytes.subarray(0, SUMMARY_LIMIT - new TextEncoder().encode(note).length));
  return kept.replace(/�$/, "") + note;
}
