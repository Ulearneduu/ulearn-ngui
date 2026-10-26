import { Injectable } from '@angular/core';
import { supabase } from '../core/supabase.client';
import {
  InterviewSessionStatus,
  InterviewSessionSummary,
  InterviewTemplate,
  InterviewTemplateKind,
} from '../models';

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
  interview_templates: { title: string; kind: string } | { title: string; kind: string }[] | null;
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
): { title: string; kind: string } | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row.title !== 'string' || typeof row.kind !== 'string') return null;
  return row;
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
      .select('id, status, template_id, prompt_version, interview_templates(title, kind)')
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
    };
  }
}

export function interviewErrorMessage(error: unknown, fallback: string): string {
  if (isRecord(error) && typeof error['message'] === 'string' && error['message'].trim()) {
    return error['message'];
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}
