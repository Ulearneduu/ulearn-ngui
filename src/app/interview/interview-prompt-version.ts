/**
 * INT-009 session prompt_version helpers.
 * New sessions store the template version number as text ("1", "2", ...).
 * Legacy sessions may still contain slug:createdAt values.
 */

export function parseTemplateVersionNumber(promptVersion: unknown): number | null {
  if (typeof promptVersion !== 'string') return null;
  const trimmed = promptVersion.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

export function formatTemplateVersionNumber(version: number): string {
  if (!Number.isInteger(version) || version <= 0) {
    throw new Error('Template version must be a positive integer.');
  }
  return String(version);
}
