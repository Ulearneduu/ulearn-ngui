import { Injectable } from '@angular/core';
import { invokeAuthedFunction, supabase } from '../core/supabase.client';
import {
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
import { positiveDurationMinutes } from './interview-timer';

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
  interview_templates:
    | { title: string; kind: string; duration_minutes: number | string }
    | { title: string; kind: string; duration_minutes: number | string }[]
    | null;
}

/**
 * Templates have no prompt-version column yet. The session still requires
 * prompt_version, so store the published row identity the student started.
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
  value: SessionRow['interview_templates']
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
   * Returns the new session id.
   */
  async startSession(template: InterviewTemplate): Promise<string> {
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError) throw userError;
    const userId = userData.user?.id;
    if (!userId) {
      throw new Error('Sign in again to start an interview.');
    }

    const { data, error } = await supabase
      .from('interview_sessions')
      .insert({
        user_id: userId,
        template_id: template.id,
        status: 'in_progress',
        prompt_version: interviewPromptVersion(template),
      })
      .select('id')
      .single();

    if (error) throw error;
    if (!isRecord(data) || typeof data['id'] !== 'string' || !data['id']) {
      throw new Error('The interview session was not created.');
    }
    return data['id'];
  }

  async getOwnSession(sessionId: string): Promise<InterviewSessionSummary | null> {
    const { data, error } = await supabase
      .from('interview_sessions')
      .select('id, status, template_id, prompt_version, started_at, ended_at, interview_templates(title, kind, duration_minutes)')
      .eq('id', sessionId)
      .maybeSingle();

    if (error) throw error;
    if (!isRecord(data)) return null;

    const row = data as unknown as SessionRow;
    const template = embeddedTemplate(row.interview_templates);
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
