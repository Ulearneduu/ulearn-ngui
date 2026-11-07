import { Injectable, inject } from '@angular/core';
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
import { InterviewService } from './interview.service';
import {
  InterviewRequestError,
  interviewFunctionError,
  parseInterviewTurnResponse,
  type InterviewTurnResponse,
} from './interview-api';
import {
  InterviewCodingProblem,
  InterviewCodingPublicTestResult,
  InterviewSessionCodingResult,
  activeInterviewCodingProblem,
  parseInterviewSessionCodingRow,
} from './interview-coding';
import {
  parseEvaluationSnapshot,
  parseInterviewEvaluationResponse,
  type InterviewEvaluationResponse,
} from './interview-evaluation';
import { formatTemplateVersionNumber } from './interview-prompt-version';
import {
  effectiveOverallScore,
  hasMentorAdjustments,
  overridesForEvalVersion,
  parseOverrideRows,
} from './interview-score-overrides';
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

interface SessionEmbeddedTemplate {
  title: string;
  kind: string;
  duration_minutes: number | string;
  coding_json?: unknown;
}

interface SessionRow {
  id: string;
  status: string;
  template_id: string;
  prompt_version: string;
  started_at: string;
  ended_at?: string | null;
  template_version_id?: string | null;
  interview_templates: SessionEmbeddedTemplate | SessionEmbeddedTemplate[] | null;
  interview_template_versions?: SessionEmbeddedTemplate | SessionEmbeddedTemplate[] | null;
}

export interface InterviewSessionDetails extends InterviewSessionSummary {
  codingProblem: InterviewCodingProblem | null;
}

interface HistorySessionRow {
  id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  overall_score: number | null;
  eval_version?: string | null;
  mentor_review_published?: boolean | null;
  redo_of_session_id?: string | null;
  interview_templates: { title: string } | { title: string }[] | null;
}

interface RedoParentRow {
  id: string;
  user_id: string;
  status: string;
  template_id: string;
  prompt_version: string;
  template_version_id: string | null;
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
): { title: string; kind: string; duration_minutes: number; coding_json?: unknown } | null {
  const row = Array.isArray(value) ? value[0] : value;
  const duration = positiveDurationMinutes(row?.duration_minutes);
  if (!row || typeof row.title !== 'string' || typeof row.kind !== 'string' || duration === null) {
    return null;
  }
  return {
    title: row.title,
    kind: row.kind,
    duration_minutes: duration,
    coding_json: row.coding_json,
  };
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
  private readonly interviewService = inject(InterviewService);
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

  /**
   * Start a redo of a completed own session (INT-011).
   * Reuses the parent's template_id, template_version_id, and prompt_version.
   * Does not resolve the latest published version.
   */
  async startRedoSession(previousSessionId: string): Promise<string> {
    const parentId = previousSessionId.trim();
    if (!parentId) {
      throw new Error('This interview could not be redone.');
    }

    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError) throw userError;
    const userId = userData.user?.id;
    if (!userId) {
      throw new Error('Sign in again to start an interview.');
    }

    const quota = await this.interviewService.loadQuota();
    if (!quota.ok) {
      throw new Error(quota.error || 'Could not load weekly interview quota.');
    }
    if (quota.quota.remaining <= 0) {
      throw new Error(
        `Weekly mock interview limit reached (${quota.quota.used}/${quota.quota.weekly_limit}). Try again after your quota resets.`
      );
    }

    const { data: parentRaw, error: parentError } = await supabase
      .from('interview_sessions')
      .select('id, user_id, status, template_id, prompt_version, template_version_id')
      .eq('id', parentId)
      .maybeSingle();
    if (parentError) throw parentError;
    if (!isRecord(parentRaw)) {
      throw new Error('This interview could not be opened for a redo.');
    }

    const parent = parentRaw as unknown as RedoParentRow;
    if (parent.user_id !== userId) {
      throw new Error('This interview could not be opened for a redo.');
    }
    if (parent.status !== 'completed') {
      throw new Error('Only a completed interview can be redone.');
    }
    if (typeof parent.template_id !== 'string' || !parent.template_id) {
      throw new Error('This interview could not be redone.');
    }
    if (typeof parent.prompt_version !== 'string' || !parent.prompt_version.trim()) {
      throw new Error('This interview could not be redone.');
    }

    const insertPayload: Record<string, unknown> = {
      user_id: userId,
      template_id: parent.template_id,
      status: 'in_progress',
      prompt_version: parent.prompt_version,
      redo_of_session_id: parent.id,
    };
    if (typeof parent.template_version_id === 'string' && parent.template_version_id) {
      insertPayload['template_version_id'] = parent.template_version_id;
    }

    const { data, error } = await supabase
      .from('interview_sessions')
      .insert(insertPayload)
      .select('id')
      .single();

    if (error) throw error;
    if (!isRecord(data) || typeof data['id'] !== 'string' || !data['id']) {
      throw new Error('The redo interview session was not created.');
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
   * When mentor_review_published, overallScore is the mentor-effective value
   * (AI interview_sessions.overall_score is never overwritten).
   */
  async listOwnSessions(): Promise<InterviewHistoryItem[]> {
    const { data, error } = await supabase
      .from('interview_sessions')
      .select(
        'id, status, started_at, ended_at, overall_score, eval_version, mentor_review_published, redo_of_session_id, interview_templates(title)'
      )
      .order('started_at', { ascending: false })
      .limit(HISTORY_LIST_LIMIT);

    if (error) throw error;

    const rows: HistorySessionRow[] = [];
    for (const raw of data ?? []) {
      const row = raw as unknown as HistorySessionRow;
      if (typeof row.id !== 'string' || typeof row.status !== 'string') continue;
      if (!isSessionStatus(row.status)) continue;
      if (typeof row.started_at !== 'string') continue;
      rows.push(row);
    }

    const publishedIds = rows
      .filter((row) => row.mentor_review_published === true)
      .map((row) => row.id);

    const overridesBySession = new Map<string, ReturnType<typeof parseOverrideRows>>();
    const scoresBySession = new Map<
      string,
      { competency: string; score: number; evalVersion: string }[]
    >();

    if (publishedIds.length > 0) {
      const [overrideQuery, scoreQuery] = await Promise.all([
        supabase
          .from('interview_score_overrides')
          .select(
            'id, session_id, mentor_id, target_kind, competency, eval_version, old_score, new_score, reason, created_at'
          )
          .in('session_id', publishedIds)
          .order('created_at', { ascending: true }),
        supabase
          .from('interview_scores')
          .select('session_id, competency, score, eval_version')
          .in('session_id', publishedIds),
      ]);
      if (overrideQuery.error) throw overrideQuery.error;
      if (scoreQuery.error) throw scoreQuery.error;

      for (const sessionId of publishedIds) {
        overridesBySession.set(
          sessionId,
          parseOverrideRows(
            (overrideQuery.data ?? []).filter(
              (row) => isRecord(row) && row['session_id'] === sessionId
            )
          )
        );
      }

      for (const raw of scoreQuery.data ?? []) {
        if (!isRecord(raw) || typeof raw['session_id'] !== 'string') continue;
        if (typeof raw['competency'] !== 'string') continue;
        if (typeof raw['eval_version'] !== 'string' || !raw['eval_version']) continue;
        const score =
          typeof raw['score'] === 'number'
            ? raw['score']
            : typeof raw['score'] === 'string'
              ? Number(raw['score'])
              : NaN;
        if (!Number.isFinite(score)) continue;
        const list = scoresBySession.get(raw['session_id']) ?? [];
        list.push({
          competency: raw['competency'],
          score,
          evalVersion: raw['eval_version'],
        });
        scoresBySession.set(raw['session_id'], list);
      }
    }

    const items: InterviewHistoryItem[] = [];
    for (const row of rows) {
      const template = embeddedTemplateTitle(row.interview_templates);
      const aiScore =
        typeof row.overall_score === 'number' && Number.isFinite(row.overall_score)
          ? row.overall_score
          : null;
      const endedAt = typeof row.ended_at === 'string' ? row.ended_at : null;
      const published = row.mentor_review_published === true;
      const evalVersion =
        typeof row.eval_version === 'string' && row.eval_version.trim()
          ? row.eval_version.trim()
          : null;

      let overallScore = aiScore;
      let mentorAdjusted = false;
      if (published && evalVersion) {
        const overrides = overridesForEvalVersion(
          overridesBySession.get(row.id) ?? [],
          evalVersion
        );
        const aiCompetencies = (scoresBySession.get(row.id) ?? [])
          .filter((item) => item.evalVersion === evalVersion)
          .map((item) => ({ competency: item.competency, score: item.score }));
        const effective = effectiveOverallScore(aiCompetencies, overrides, aiScore);
        overallScore = effective;
        mentorAdjusted = hasMentorAdjustments(aiCompetencies, overrides);
      }

      if (!isSessionStatus(row.status)) continue;
      items.push({
        id: row.id,
        templateTitle: template ?? 'Interview session',
        status: row.status,
        startedAt: row.started_at,
        endedAt,
        overallScore,
        mentorReviewPublished: published,
        mentorAdjusted,
        redoOfSessionId:
          typeof row.redo_of_session_id === 'string' ? row.redo_of_session_id : null,
      });
    }
    return items;
  }

  async getOwnSession(sessionId: string): Promise<InterviewSessionDetails | null> {
    const { data, error } = await supabase
      .from('interview_sessions')
      .select(
        'id, status, template_id, prompt_version, template_version_id, redo_of_session_id, started_at, ended_at, interview_templates(title, kind, duration_minutes, coding_json), interview_template_versions(title, kind, duration_minutes, coding_json)'
      )
      .eq('id', sessionId)
      .maybeSingle();

    if (error) throw error;
    if (!isRecord(data)) return null;

    const row = data as unknown as SessionRow & { redo_of_session_id?: string | null };
    const snapshot = embeddedTemplate(row.interview_template_versions);
    const live = embeddedTemplate(row.interview_templates);
    const template = snapshot ?? live;
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

    const codingProblem =
      activeInterviewCodingProblem(snapshot?.coding_json) ??
      (snapshot ? null : activeInterviewCodingProblem(live?.coding_json));

    return {
      id: row.id,
      status: row.status,
      templateId: row.template_id,
      templateTitle: template.title,
      templateKind: template.kind,
      promptVersion: row.prompt_version,
      templateVersionId:
        typeof row.template_version_id === 'string' ? row.template_version_id : null,
      redoOfSessionId:
        typeof row.redo_of_session_id === 'string' ? row.redo_of_session_id : null,
      codingProblem,
      startedAt: row.started_at,
      endedAt: typeof row.ended_at === 'string' ? row.ended_at : null,
      durationMinutes: template.duration_minutes,
    };
  }

  async getSessionCoding(sessionId: string): Promise<InterviewSessionCodingResult | null> {
    const { data, error } = await supabase
      .from('interview_session_coding')
      .select(
        'session_id, language, code, passed_count, total_count, all_passed, results_json, problem_snapshot, updated_at, submitted_at'
      )
      .eq('session_id', sessionId)
      .maybeSingle();
    if (error) throw error;
    return parseInterviewSessionCodingRow(data);
  }

  /**
   * Run public tests for the session coding step (INT-013).
   * Persists code + results on the session for later INT-008 scorecard use.
   */
  async runCodingPublicTests(
    sessionId: string,
    code: string,
    language: string
  ): Promise<{
    results: InterviewCodingPublicTestResult[];
    passedCount: number;
    total: number;
    allPassed: boolean;
  }> {
    const { data, error } = await invokeAuthedFunction<{
      results?: InterviewCodingPublicTestResult[];
      passedCount?: number;
      total?: number;
      allPassed?: boolean;
      error?: string;
    }>('interview-run-code', {
      sessionId,
      code,
      language,
      persist: true,
    });

    if (error) throw await interviewFunctionError(error);
    if (!data || !Array.isArray(data.results)) {
      throw new InterviewRequestError(
        typeof data?.error === 'string' && data.error.trim()
          ? data.error
          : 'Could not run public tests.',
        'BAD_RESPONSE'
      );
    }
    return {
      results: data.results,
      passedCount: typeof data.passedCount === 'number' ? data.passedCount : 0,
      total: typeof data.total === 'number' ? data.total : data.results.length,
      allPassed: data.allPassed === true,
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
  async completeOwnSession(sessionId: string): Promise<InterviewSessionDetails> {
    const result = await this.finishOwnSession(sessionId, 'manual');
    if (!result.session || result.session.status !== 'completed') {
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
      .select(
        'id, status, template_id, prompt_version, template_version_id, redo_of_session_id, started_at, ended_at, overall_score, evaluation_status, eval_version, evaluated_at, evaluation_summary, evaluation_strengths, evaluation_improvements, evaluation_tips, evaluation_claimed_at, mentor_review_published, interview_templates(title, kind, duration_minutes)'
      )
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

    // RLS only returns override rows when mentor_review_published is true for this owner.
    let overrides: unknown[] = [];
    if (data['mentor_review_published'] === true) {
      const overrideQuery = await supabase
        .from('interview_score_overrides')
        .select(
          'id, session_id, mentor_id, target_kind, competency, eval_version, old_score, new_score, reason, created_at'
        )
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true });
      if (overrideQuery.error) throw overrideQuery.error;
      overrides = overrideQuery.data ?? [];
    }

    return parseEvaluationSnapshot(data, scores.data ?? [], turns, overrides);
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
  session: InterviewSessionDetails | null;
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
