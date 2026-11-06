import type {
  InterviewCompetencyScore,
  InterviewEvaluationSnapshot,
  InterviewEvaluationStatus,
  InterviewSessionStatus,
  InterviewSessionSummary,
  InterviewTemplateKind,
  InterviewTurn,
} from '../models';

const SESSION_STATUSES: readonly InterviewSessionStatus[] = ['in_progress', 'completed', 'failed'];
const EVAL_STATUSES: readonly InterviewEvaluationStatus[] = ['pending', 'processing', 'completed', 'failed'];
const KINDS: readonly InterviewTemplateKind[] = ['hr', 'technical', 'domain'];
export const EVAL_POLL_MS = 2500;
export const EVAL_POLL_MAX_MS = 45_000;
export const EVAL_RECLAIM_MS = 180_000;

export type ResultPhase =
  | 'not_completed'
  | 'empty_transcript'
  | 'incomplete_transcript'
  | 'ready'
  | 'processing'
  | 'processing_timeout'
  | 'failed'
  | 'completed'
  | 'partial';

export function evaluationPhase(input: {
  sessionStatus: string;
  evaluationStatus: string | null;
  overallScore: number | null;
  competencyCount: number;
  userTurns: number;
  assistantTurns: number;
  pollTimedOut: boolean;
}): ResultPhase {
  if (input.sessionStatus !== 'completed') return 'not_completed';
  if (input.evaluationStatus === 'completed' && input.overallScore !== null && input.competencyCount > 0) {
    return 'completed';
  }
  if (input.evaluationStatus === 'completed') return 'partial';
  if (input.userTurns + input.assistantTurns === 0) return 'empty_transcript';
  if (input.userTurns < 1 || input.assistantTurns < 1) return 'incomplete_transcript';
  if (input.evaluationStatus === 'failed') return 'failed';
  if (input.evaluationStatus === 'processing') {
    return input.pollTimedOut ? 'processing_timeout' : 'processing';
  }
  return 'ready';
}

export function shouldPollEvaluation(phase: ResultPhase): boolean {
  return phase === 'processing';
}

export function shouldStartEvaluation(phase: ResultPhase, userRetry: boolean): boolean {
  if (phase === 'ready') return true;
  return userRetry && phase === 'failed';
}

export function isInterviewAccessError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
  if (code === 'FORBIDDEN' || code === 'UNAUTHORIZED') return true;
  const message = 'message' in error && typeof error.message === 'string' ? error.message : '';
  return /sign in|not signed in|session expired|do not have access/i.test(message);
}

export function canReclaimEvaluation(status: string | null, claimedAt: string | null, nowMs: number): boolean {
  if (status !== 'processing' || !claimedAt) return false;
  const claimed = Date.parse(claimedAt);
  return Number.isFinite(claimed) && nowMs - claimed >= EVAL_RECLAIM_MS;
}

export function scoreBarPercent(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(100, Math.max(0, Math.round(score * 100) / 100));
}

export function formatScore(score: number): string {
  if (!Number.isFinite(score)) return '0';
  const rounded = Math.round(score * 100) / 100;
  return rounded.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

export function interviewKindLabel(kind: string): string {
  if (kind === 'hr') return 'HR';
  if (kind === 'technical') return 'Technical';
  if (kind === 'domain') return 'Domain';
  return kind;
}

export function formatCompletedAt(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export interface InterviewEvaluationResponse {
  status: 'completed';
  evalVersion: string;
  overallScore: number;
  summary: string;
  strengths: string[];
  improvements: string[];
  evaluatedAt: string | null;
  competencies: { competency: string; score: number; feedback: string; evidence: string }[];
}

export function parseInterviewEvaluationResponse(value: unknown): InterviewEvaluationResponse | null {
  if (!isRecord(value) || value['status'] !== 'completed') return null;
  const evalVersion = value['evalVersion'];
  const summary = value['summary'];
  const overall = finiteScore(value['overallScore']);
  const strengths = textList(value['strengths']);
  const improvements = textList(value['improvements']);
  const competencies = responseCompetencies(value['competencies']);
  const evaluatedAt = value['evaluatedAt'];
  if (typeof evalVersion !== 'string' || !evalVersion.trim() || typeof summary !== 'string' || !summary.trim()) return null;
  if (overall === null || !strengths?.length || !improvements?.length || !competencies) return null;
  return {
    status: 'completed',
    evalVersion: evalVersion.trim(),
    overallScore: overall,
    summary: summary.trim(),
    strengths,
    improvements,
    evaluatedAt: typeof evaluatedAt === 'string' ? evaluatedAt : null,
    competencies,
  };
}

export function parseEvaluationSnapshot(
  sessionRow: unknown,
  scoreRows: unknown,
  turnRows: readonly InterviewTurn[]
): InterviewEvaluationSnapshot | null {
  if (!isRecord(sessionRow)) return null;
  const id = sessionRow['id'];
  const status = sessionRow['status'];
  const templateId = sessionRow['template_id'];
  const promptVersion = sessionRow['prompt_version'];
  const startedAt = sessionRow['started_at'];
  const template = embeddedTemplate(sessionRow['interview_templates']);
  if (
    typeof id !== 'string' ||
    typeof status !== 'string' ||
    !isSessionStatus(status) ||
    typeof templateId !== 'string' ||
    typeof promptVersion !== 'string' ||
    typeof startedAt !== 'string' ||
    !template
  ) {
    return null;
  }

  const evaluationStatus = sessionRow['evaluation_status'];
  const evalVersion = sessionRow['eval_version'];
  const version = typeof evalVersion === 'string' && evalVersion.trim() ? evalVersion.trim() : null;
  const endedAt = sessionRow['ended_at'];
  const evaluatedAt = sessionRow['evaluated_at'];
  const claimedAt = sessionRow['evaluation_claimed_at'];
  const summary = sessionRow['evaluation_summary'];
  const session: InterviewSessionSummary = {
    id,
    status,
    templateId,
    templateTitle: template.title,
    templateKind: template.kind,
    promptVersion,
    startedAt,
    endedAt: typeof endedAt === 'string' ? endedAt : null,
    durationMinutes: template.durationMinutes,
  };

  const competencies = parseScores(scoreRows).filter((score) => !version || score.evalVersion === version);
  const turns = [...turnRows].sort((left, right) => left.seq - right.seq);

  return {
    session,
    evaluationStatus: typeof evaluationStatus === 'string' && isEvalStatus(evaluationStatus) ? evaluationStatus : null,
    evalVersion: version,
    overallScore: finiteScore(sessionRow['overall_score']),
    summary: typeof summary === 'string' && summary.trim() ? summary.trim() : null,
    strengths: textList(sessionRow['evaluation_strengths']) ?? [],
    improvements: textList(sessionRow['evaluation_improvements']) ?? [],
    evaluatedAt: typeof evaluatedAt === 'string' ? evaluatedAt : null,
    claimedAt: typeof claimedAt === 'string' ? claimedAt : null,
    competencies,
    turns,
  };
}

function parseScores(value: unknown): InterviewCompetencyScore[] {
  if (!Array.isArray(value)) return [];
  const scores: InterviewCompetencyScore[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item['competency'] !== 'string') continue;
    const score = finiteScore(item['score']);
    const feedback = typeof item['rationale'] === 'string' ? item['rationale'].trim() : '';
    const evidence = typeof item['evidence'] === 'string' ? item['evidence'].trim() : '';
    const evalVersion = item['eval_version'];
    if (score === null || !feedback || typeof evalVersion !== 'string') continue;
    const id = typeof item['id'] === 'string' ? item['id'] : `${evalVersion}:${item['competency']}`;
    scores.push({
      id,
      competency: item['competency'],
      score,
      feedback,
      evidence,
      evalVersion,
    });
  }
  return scores;
}

function responseCompetencies(value: unknown): InterviewEvaluationResponse['competencies'] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const rows: InterviewEvaluationResponse['competencies'] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item['competency'] !== 'string' || !item['competency'].trim()) return null;
    const score = finiteScore(item['score']);
    const feedback = typeof item['feedback'] === 'string' ? item['feedback'].trim() : '';
    const evidence = typeof item['evidence'] === 'string' ? item['evidence'].trim() : '';
    if (score === null || !feedback) return null;
    rows.push({ competency: item['competency'].trim(), score, feedback, evidence });
  }
  return rows;
}

function embeddedTemplate(value: unknown): { title: string; kind: InterviewTemplateKind; durationMinutes: number } | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (!isRecord(row) || typeof row['title'] !== 'string' || typeof row['kind'] !== 'string') return null;
  if (!isKind(row['kind'])) return null;
  const duration = typeof row['duration_minutes'] === 'number' ? row['duration_minutes'] : Number(row['duration_minutes']);
  if (!Number.isInteger(duration) || duration <= 0) return null;
  return { title: row['title'], kind: row['kind'], durationMinutes: duration };
}

function textList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) return null;
    items.push(item.trim());
  }
  return items;
}

function finiteScore(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return null;
  return Math.round(parsed * 100) / 100;
}

function isSessionStatus(value: string): value is InterviewSessionStatus {
  return (SESSION_STATUSES as readonly string[]).includes(value);
}

function isEvalStatus(value: string): value is InterviewEvaluationStatus {
  return (EVAL_STATUSES as readonly string[]).includes(value);
}

function isKind(value: string): value is InterviewTemplateKind {
  return (KINDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
