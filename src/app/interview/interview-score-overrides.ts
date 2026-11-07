/**
 * INT-015 pure helpers: merge append-only mentor overrides onto immutable AI scores.
 * AI baselines are never mutated here — callers keep original rows separately.
 */

export type InterviewOverrideTargetKind = 'overall' | 'competency';

export interface InterviewScoreOverrideRecord {
  id: string;
  sessionId: string;
  mentorId: string;
  mentorName?: string | null;
  targetKind: InterviewOverrideTargetKind;
  competency: string | null;
  evalVersion: string;
  oldScore: number;
  newScore: number;
  reason: string;
  createdAt: string;
}

export interface AiCompetencyBaseline {
  competency: string;
  score: number;
}

/** Round like INT-008 apply_interview_evaluation (numeric round half away / pg round). */
export function roundInterviewScore(score: number): number {
  if (!Number.isFinite(score)) return NaN;
  return Math.round(score * 100) / 100;
}

export function isValidInterviewScore(score: number): boolean {
  return Number.isFinite(score) && score >= 0 && score <= 100;
}

export function isValidOverrideReason(reason: string): boolean {
  return reason.trim().length >= 10;
}

/** Keep overrides that match the session's immutable eval_version (SQL does the same). */
export function overridesForEvalVersion(
  overrides: readonly InterviewScoreOverrideRecord[],
  evalVersion: string | null | undefined
): InterviewScoreOverrideRecord[] {
  const version = typeof evalVersion === 'string' ? evalVersion.trim() : '';
  if (!version) return [];
  return overrides.filter((row) => row.evalVersion === version);
}

/** Latest override for a target wins (append-only history ordered by createdAt). */
export function latestOverrideForTarget(
  overrides: readonly InterviewScoreOverrideRecord[],
  targetKind: InterviewOverrideTargetKind,
  competency: string | null = null
): InterviewScoreOverrideRecord | null {
  const normalized = competency?.trim() ?? null;
  let latest: InterviewScoreOverrideRecord | null = null;
  for (const row of overrides) {
    if (row.targetKind !== targetKind) continue;
    if (targetKind === 'overall') {
      if (row.competency != null) continue;
    } else if ((row.competency?.trim() ?? '') !== (normalized ?? '')) {
      continue;
    }
    if (!latest || row.createdAt >= latest.createdAt) {
      latest = row;
    }
  }
  return latest;
}

export function effectiveCompetencyScore(
  competency: string,
  aiScore: number,
  overrides: readonly InterviewScoreOverrideRecord[]
): number {
  const latest = latestOverrideForTarget(overrides, 'competency', competency);
  if (latest) return roundInterviewScore(latest.newScore);
  return roundInterviewScore(aiScore);
}

/**
 * Overall: latest overall override wins; otherwise mean of effective competencies
 * (same applicable-set averaging as INT-008).
 */
export function effectiveOverallScore(
  aiCompetencies: readonly AiCompetencyBaseline[],
  overrides: readonly InterviewScoreOverrideRecord[],
  aiOverallScore: number | null = null
): number | null {
  const overall = latestOverrideForTarget(overrides, 'overall', null);
  if (overall) return roundInterviewScore(overall.newScore);

  if (aiCompetencies.length === 0) {
    return aiOverallScore === null ? null : roundInterviewScore(aiOverallScore);
  }

  let sum = 0;
  for (const row of aiCompetencies) {
    sum += effectiveCompetencyScore(row.competency, row.score, overrides);
  }
  return roundInterviewScore(sum / aiCompetencies.length);
}

export function hasMentorAdjustments(
  aiCompetencies: readonly AiCompetencyBaseline[],
  overrides: readonly InterviewScoreOverrideRecord[]
): boolean {
  if (latestOverrideForTarget(overrides, 'overall', null)) return true;
  return aiCompetencies.some(
    (row) => latestOverrideForTarget(overrides, 'competency', row.competency) !== null
  );
}

export function parseOverrideRows(value: unknown): InterviewScoreOverrideRecord[] {
  if (!Array.isArray(value)) return [];
  const rows: InterviewScoreOverrideRecord[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const targetKind = item['targetKind'] ?? item['target_kind'];
    if (targetKind !== 'overall' && targetKind !== 'competency') continue;
    const oldScore = finiteScore(item['oldScore'] ?? item['old_score']);
    const newScore = finiteScore(item['newScore'] ?? item['new_score']);
    const reason = typeof item['reason'] === 'string' ? item['reason'].trim() : '';
    const evalVersion =
      typeof item['evalVersion'] === 'string'
        ? item['evalVersion']
        : typeof item['eval_version'] === 'string'
          ? item['eval_version']
          : '';
    const createdAt =
      typeof item['createdAt'] === 'string'
        ? item['createdAt']
        : typeof item['created_at'] === 'string'
          ? item['created_at']
          : '';
    const id = typeof item['id'] === 'string' ? item['id'] : '';
    const sessionId =
      typeof item['sessionId'] === 'string'
        ? item['sessionId']
        : typeof item['session_id'] === 'string'
          ? item['session_id']
          : '';
    const mentorId =
      typeof item['mentorId'] === 'string'
        ? item['mentorId']
        : typeof item['mentor_id'] === 'string'
          ? item['mentor_id']
          : '';
    if (!id || !sessionId || !mentorId || !evalVersion || !createdAt || !reason) continue;
    if (oldScore === null || newScore === null) continue;
    const competencyRaw = item['competency'];
    const competency =
      typeof competencyRaw === 'string' && competencyRaw.trim() ? competencyRaw.trim() : null;
    if (targetKind === 'overall' && competency !== null) continue;
    if (targetKind === 'competency' && !competency) continue;
    const mentorName =
      typeof item['mentorName'] === 'string'
        ? item['mentorName']
        : typeof item['mentor_name'] === 'string'
          ? item['mentor_name']
          : null;
    rows.push({
      id,
      sessionId,
      mentorId,
      mentorName,
      targetKind,
      competency,
      evalVersion,
      oldScore,
      newScore,
      reason,
      createdAt,
    });
  }
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function finiteScore(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return null;
  return roundInterviewScore(parsed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
