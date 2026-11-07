/**
 * INT-009 prompt version helpers.
 * New sessions store prompt_version as a positive integer string ("1", "2", ...).
 * Legacy sessions store slug:createdAt and have no template_version_id.
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

export type TemplateFacts = {
  systemPrompt: string;
  durationMinutes: number;
};

export function pickTemplateFacts(row: {
  system_prompt?: unknown;
  duration_minutes?: unknown;
} | null | undefined, positiveDurationMinutes: (value: unknown) => number | null): TemplateFacts | null {
  if (!row) return null;
  const prompt = typeof row.system_prompt === 'string' ? row.system_prompt.trim() : '';
  const duration = positiveDurationMinutes(row.duration_minutes);
  if (!prompt || duration === null) return null;
  return { systemPrompt: prompt, durationMinutes: duration };
}
