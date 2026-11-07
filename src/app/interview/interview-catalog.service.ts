import { Injectable } from '@angular/core';
import { invokeAuthedFunction, supabase } from '../core/supabase.client';
import {
  InterviewEvaluationSnapshot,
  InterviewHistoryItem,
  InterviewSessionStatus,
  InterviewSessionSummary,
  InterviewTemplate,
  InterviewTemplateKind,
  InterviewTurn,
  InterviewTurnRole,
} from '../models';
import {
  InterviewRequestError,
  interviewFunctionError,
  parseInterviewTurnResponse,
  type InterviewTurnResponse,
} from './interview-api';
import {
  parseEvaluationSnapshot,
  parseInterviewEvaluationResponse,
  type InterviewEvaluationResponse,
} from './interview-evaluation';
import { formatTemplateVersionNumber } from './interview-prompt-version';
import { positiveDurationMinutes } from './interview-timer';

const HISTORY_LIST_LIMIT = 50;

const TEMPLATE_KINDS: readonly InterviewTemplateKind[] = ['hr', 'technical', 'domain'];
const SESSION_STATUSES: readonly InterviewSessionStatus[] = ['in_progress', 'completed', 'failed'];

interface TemplateRow {
  id: string;
  slug: string;
  title: string;
  kind: string;
  duration_minutes: number;
  status: string;
  created_at: string;
}

interface SessionRow {
  id: string;
  status: string;
  template_id: string;
  prompt_version: string;
  started_at: string;
  ended_at?: string | null;
  template_version_id?: string | null;
  interview_templates:
    | { title: string; kind: string; duration_minutes: number | string }
    | { title: string; kind: string; duration_minutes: number | string }[]
    | null;
  interview_template_versions?:
    | { title: string; kind: string; duration_minutes: number | string }
    | { title: string; kind: string; duration_minutes: number | string }[]
    | null;
}

interface HistorySessionRow {
  id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  overall_score: number | null;
  interview_templates: { title: string } | { title: string }[] | null;
}

/**
 * @deprecated Legacy label used before INT-009 version snapshots.
 * New sessions store the integer template version via formatTemplateVersionNumber.
 */
export function interviewPromptVersion(template: Pick<InterviewTemplate, 'slug' | 'createdAt'>): string {
  return `${template.slug}:${template.createdAt}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTemplateKind(value: string): value is InterviewTemplateKind {
  return (TEMPLATE_KINDS as readonly string[]).includes(value);
}

function isSessionStatus(value: string): value is InterviewSessionStatus {
  return (SESSION_STATUSES as readonly string[]).includes(value);
}

function asTemplateRow(value: unknown): TemplateRow | null {
  if (!isRecord(value)) return null;
  const id = value['id'];
  const slug = value['slug'];
  const title = value['title'];
  const kind = value['kind'];
  const duration = value['duration_minutes'];
  const status = value['status'];
  const createdAt = value['created_at'];
  if (
    typeof id !== 'string' ||
    typeof slug !== 'string' ||
    typeof title !== 'string' ||
    typeof kind !== 'string' ||
    typeof duration !== 'number' ||
    typeof status !== 'string' ||
    typeof createdAt !== 'string'
  ) {
    return null;
  }
  return {
    id,
    slug,
    title,
    kind,
    duration_minutes: duration,
    status,
    created_at: createdAt,
  };
}

function embeddedTemplate(
  value:
    | SessionRow['interview_templates']
    | SessionRow['interview_template_versions']
    | undefined
): { title: string; kind: string; duration_minutes: number } | null {
  const row = Array.isArray(value) ? value[0] : value;
  const duration = positiveDurationMinutes(row?.duration_minutes);
  if (!row || typeof row.title !== 'string' || typeof row.kind !== 'string' || duration === null) {
    return null;
  }
  return { title: row.title, kind: row.kind, duration_minutes: duration };
}

const TURN_ROLES: readonly InterviewTurnRole[] = ['user', 'assistant'];

function asTurn(value: unknown): InterviewTurn | null {
  if (!isRecord(value)) return null;
  const id = value['id'];
  const role = value['role'];
  const content = value['content'];
  const seq = value['seq'];
  const createdAt = value['created_at'] ?? value['createdAt'];
  if (
    typeof id !== 'string' ||
    typeof role !== 'string' ||
    typeof content !== 'string' ||
    typeof createdAt !== 'string' ||
    !TURN_ROLES.includes(role as InterviewTurnRole) ||
    (typeof seq !== 'number' && typeof seq !== 'string')
  ) {
    return null;
  }
  const seqNumber = typeof seq === 'number' ? seq : Number(seq);
  if (!Number.isInteger(seqNumber) || seqNumber <= 0) return null;
  return { id, role: role as InterviewTurnRole, content, seq: seqNumber, createdAt };
}

function embeddedTemplateTitle(
  value: HistorySessionRow['interview_templates']
): string | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row.title !== 'string') return null;
  return row.title;
}

@Injectable({ providedIn: 'root' })
export class InterviewCatalogService {
  /** Published templates only. Drafts are excluded here and by RLS. */
  async listPublishedTemplates(): Promise<InterviewTemplate[]> {
    const { data, error } = await supabase
      .from('interview_templates')
      .select('id, slug, title, kind, duration_minutes, status, created_at')
      .eq('status', 'published')
      .order('title', { ascending: true });

    if (error) throw error;

    const templates: InterviewTemplate[] = [];
    for (const item of data ?? []) {
      const row = asTemplateRow(item);
      if (!row || row.status !== 'published' || !isTemplateKind(row.kind)) continue;
      templates.push({
        id: row.id,
        slug: row.slug,
        title: row.title,
        kind: row.kind,
        durationMinutes: row.duration_minutes,
        createdAt: row.created_at,
      });
    }
    return templates;
  }

  /**
   * Insert an in-progress session for the signed-in student.
   * Pins prompt_version + template_version_id to the template's current snapshot.
   * Returns the new session id.
   */
  async startSession(template: InterviewTemplate): Promise<string> {
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError) throw userError;
    const userId = userData.user?.id;
    if (!userId) {
      throw new Error('Sign in again to start an interview.');
    }

    const version = await this.latestPublishedTemplateVersion(template.id);
    if (!version) {
      throw new Error('This interview is not available right now.');
    }

    const { data, error } = await supabase
      .from('interview_sessions')
      .insert({
        user_id: userId,
        template_id: template.id,
        status: 'in_progress',
        prompt_version: formatTemplateVersionNumber(version.version),
        template_version_id: version.id,
      })
      .select('id')
      .single();

    if (error) throw error;
    if (!isRecord(data) || typeof data['id'] !== 'string' || !data['id']) {
      throw new Error('The interview session was not created.');
    }
    return data['id'];
  }

  /** Latest published snapshot for a template (INT-009). */
  private async latestPublishedTemplateVersion(
    templateId: string
  ): Promise<{ id: string; version: number } | null> {
    const { data: template, error: templateError } = await supabase
      .from('interview_templates')
      .select('id, status, current_version')
      .eq('id', templateId)
      .eq('status', 'published')
      .maybeSingle();

    if (templateError) throw templateError;
    if (!isRecord(template)) return null;
    const currentVersion = template['current_version'];
    const versionNumber =
      typeof currentVersion === 'number'
        ? currentVersion
        : typeof currentVersion === 'string'
          ? Number(currentVersion)
          : NaN;
    if (!Number.isInteger(versionNumber) || versionNumber <= 0) return null;

    const { data: versionRow, error: versionError } = await supabase
      .from('interview_template_versions')
      .select('id, version')
      .eq('template_id', templateId)
      .eq('version', versionNumber)
      .maybeSingle();

    if (versionError) throw versionError;
    if (!isRecord(versionRow) || typeof versionRow['id'] !== 'string') return null;
    const storedVersion = versionRow['version'];
    const parsedVersion =
      typeof storedVersion === 'number'
        ? storedVersion
        : typeof storedVersion === 'string'
          ? Number(storedVersion)
          : NaN;
    if (!Number.isInteger(parsedVersion) || parsedVersion <= 0) return null;
    return { id: versionRow['id'], version: parsedVersion };
  }

  /**
   * List the signed-in student's sessions (newest first). Ownership enforced by RLS.
   */
  async listOwnSessions(): Promise<InterviewHistoryItem[]> {
    const { data, error } = await supabase
      .from('interview_sessions')
      .select('id, status, started_at, ended_at, overall_score, interview_templates(title)')
      .order('started_at', { ascending: false })
      .limit(HISTORY_LIST_LIMIT);

    if (error) throw error;

    const items: InterviewHistoryItem[] = [];
    for (const raw of data ?? []) {
      const row = raw as unknown as HistorySessionRow;
      if (typeof row.id !== 'string' || typeof row.status !== 'string') continue;
      if (!isSessionStatus(row.status)) continue;
      if (typeof row.started_at !== 'string') continue;

      const template = embeddedTemplateTitle(row.interview_templates);
      const score =
        typeof row.overall_score === 'number' && Number.isFinite(row.overall_score)
          ? row.overall_score
          : null;
      const endedAt = typeof row.ended_at === 'string' ? row.ended_at : null;

      items.push({
        id: row.id,
        templateTitle: template ?? 'Interview session',
        status: row.status,
        startedAt: row.started_at,
        endedAt,
        overallScore: score,
      });
    }
    return items;
  }

  async getOwnSession(sessionId: string): Promise<InterviewSessionSummary | null> {
    const { data, error } = await supabase
      .from('interview_sessions')
      .select(
        'id, status, template_id, prompt_version, template_version_id, started_at, ended_at, interview_templates(title, kind, duration_minutes), interview_template_versions(title, kind, duration_minutes)'
      )
      .eq('id', sessionId)
      .maybeSingle();

    if (error) throw error;
    if (!isRecord(data)) return null;

    const row = data as unknown as SessionRow;
    const snapshot = embeddedTemplate(row.interview_template_versions);
    const template = snapshot ?? embeddedTemplate(row.interview_templates);
    if (
      typeof row.id !== 'string' ||
      typeof row.status !== 'string' ||
      typeof row.template_id !== 'string' ||
      typeof row.prompt_version !== 'string' ||
      typeof row.started_at !== 'string' ||
      !isSessionStatus(row.status) ||
      !template ||
      !isTemplateKind(template.kind)
    ) {
      return null;
    }

    return {
      id: row.id,
      status: row.status,
      templateId: row.template_id,
      templateTitle: template.title,
      templateKind: template.kind,
      promptVersion: row.prompt_version,
      startedAt: row.started_at,
      endedAt: typeof row.ended_at === 'string' ? row.ended_at : null,
      durationMinutes: template.duration_minutes,
    };
  }

  /** Stored turns for a session the signed-in student owns. Ordered by seq. */
  async listOwnTurns(sessionId: string): Promise<InterviewTurn[]> {
    const { data, error } = await supabase
      .from('interview_turns')
      .select('id, role, content, seq, created_at')
      .eq('session_id', sessionId)
      .order('seq', { ascending: true });

    if (error) throw error;

    const turns: InterviewTurn[] = [];
    for (const item of data ?? []) {
      const turn = asTurn(item);
      if (turn) turns.push(turn);
    }
    return turns.sort((left, right) => left.seq - right.seq);
  }

  /**
   * Send one answer to the interview-turn Edge Function.
   * The same clientTurnId is reused when the student retries that answer.
   */
  async submitAnswer(
    sessionId: string,
    answer: string,
    clientTurnId: string
  ): Promise<InterviewTurnResponse> {
    const { data, error } = await invokeAuthedFunction<unknown>('interview-turn', {
      sessionId,
      answer,
      clientTurnId,
    });

    if (error) throw await interviewFunctionError(error);
    const parsed = parseInterviewTurnResponse(data);
    if (!parsed) {
      throw new InterviewRequestError(
        'The interviewer response was incomplete. Please try again.',
        'BAD_RESPONSE'
      );
    }
    return parsed;
  }

  /**
   * Ask the database to finish this session.
   * manual uses the database clock. expired uses started_at + duration, and only after that time.
   * A session that is already finished comes back unchanged.
   */
  async finishOwnSession(
    sessionId: string,
    mode: 'manual' | 'expired'
  ): Promise<InterviewFinishResult> {
    const { data, error } = await supabase.rpc('finish_own_interview_session', {
      p_session_id: sessionId,
      p_mode: mode,
    });
    if (error) throw new Error('This interview could not be ended. Please try again.');

    const row = finishRow(data);
    if (!row) throw new Error('This interview could not be ended. Please try again.');
    const current = await this.getOwnSession(sessionId);
    if (row.status === 'completed' && current?.status !== 'completed') {
      throw new Error('This interview could not be ended. Please try again.');
    }
    return {
      session: current,
      status: row.status,
      timeUp: row.timeUp,
      serverNow: row.serverNow,
      endsAt: row.endsAt,
    };
  }

  /**
   * Mark the signed-in student's session completed at the database clock.
   * A second call succeeds without changing the original ended_at.
   */
  async completeOwnSession(sessionId: string): Promise<InterviewSessionSummary> {
    const result = await this.finishOwnSession(sessionId, 'manual');
    if (result.session?.status !== 'completed') {
      throw new Error('This interview could not be ended. Please try again.');
    }
    return result.session;
  }

  /**
   * Evaluation metadata, competency rows for the saved version, and the full transcript.
   * A missing session and another student's session both come back as null.
   */
  async getOwnEvaluation(sessionId: string): Promise<InterviewEvaluationSnapshot | null> {
    const { data, error } = await supabase
      .from('interview_sessions')
      .select('id, status, template_id, prompt_version, started_at, ended_at, overall_score, evaluation_status, eval_version, evaluated_at, evaluation_summary, evaluation_strengths, evaluation_improvements, evaluation_claimed_at, interview_templates(title, kind, duration_minutes)')
      .eq('id', sessionId)
      .maybeSingle();
    if (error) throw error;
    if (!isRecord(data)) return null;

    const version = typeof data['eval_version'] === 'string' ? data['eval_version'] : '';
    let scoreQuery = supabase
      .from('interview_scores')
      .select('id, competency, score, rationale, evidence, eval_version, created_at')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });
    if (version) scoreQuery = scoreQuery.eq('eval_version', version);
    const scores = await scoreQuery;
    if (scores.error) throw scores.error;

    const turns = await this.listOwnTurns(sessionId);
    return parseEvaluationSnapshot(data, scores.data ?? [], turns);
  }

  /**
   * Ask the evaluation function to score a completed session.
   * The body carries only the session id. Scores in a client payload are not sent.
   */
  async requestEvaluation(sessionId: string): Promise<InterviewEvaluationResponse> {
    const { data, error } = await invokeAuthedFunction<unknown>('interview-evaluate', { sessionId });
    if (error) {
      throw await interviewFunctionError(error, 'The evaluation could not be requested. Your interview is saved.');
    }
    const parsed = parseInterviewEvaluationResponse(data);
    if (!parsed) {
      throw new InterviewRequestError(
        'The evaluation response was incomplete. Your interview is saved.',
        'BAD_RESPONSE'
      );
    }
    return parsed;
  }
}

export interface InterviewFinishResult {
  session: InterviewSessionSummary | null;
  status: InterviewSessionStatus | null;
  timeUp: boolean;
  serverNow: string | null;
  endsAt: string | null;
}

function finishRow(data: unknown): {
  status: InterviewSessionStatus;
  timeUp: boolean;
  serverNow: string | null;
  endsAt: string | null;
} | null {
  const row = Array.isArray(data) ? data[0] : data;
  if (!isRecord(row)) return null;
  const status = row['status'];
  if (typeof status !== 'string' || !isSessionStatus(status)) return null;
  const serverNow = row['server_now'];
  const endsAt = row['ends_at'];
  return {
    status,
    timeUp: row['time_up'] === true,
    serverNow: typeof serverNow === 'string' ? serverNow : null,
    endsAt: typeof endsAt === 'string' ? endsAt : null,
  };
}

export function interviewErrorMessage(error: unknown, fallback: string): string {
  if (isRecord(error) && typeof error['message'] === 'string' && error['message'].trim()) {
    return error['message'];
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}
