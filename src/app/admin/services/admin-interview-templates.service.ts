import { Injectable } from '@angular/core';
import { supabase } from '../../core/supabase.client';
import {
  InterviewCodingProblem,
  parseInterviewCodingProblem,
  toInterviewCodingJson,
} from '../../interview/interview-coding';

export type InterviewTemplateAdminKind = 'hr' | 'technical' | 'domain';
export type InterviewTemplateAdminStatus = 'draft' | 'published';

/** Full interview_templates row for admin CRUD (not used in student catalog). */
export interface InterviewTemplateAdminRow {
  id: string;
  slug: string;
  title: string;
  kind: InterviewTemplateAdminKind;
  duration_minutes: number;
  status: InterviewTemplateAdminStatus;
  system_prompt: string;
  rubric_json: Record<string, unknown>;
  coding: InterviewCodingProblem | null;
  current_version: number;
  created_at: string;
}

export interface InterviewTemplateAdminSaveInput {
  title: string;
  kind: InterviewTemplateAdminKind;
  duration_minutes: number;
  status: InterviewTemplateAdminStatus;
  system_prompt: string;
  rubric_json: Record<string, unknown>;
  /** Technical templates only; null clears coding. */
  coding: InterviewCodingProblem | null;
}

export interface InterviewTemplateAdminCreateInput extends InterviewTemplateAdminSaveInput {
  slug: string;
}

const TEMPLATE_KINDS: readonly InterviewTemplateAdminKind[] = ['hr', 'technical', 'domain'];
const TEMPLATE_STATUSES: readonly InterviewTemplateAdminStatus[] = ['draft', 'published'];

const ADMIN_SELECT =
  'id, slug, title, kind, duration_minutes, status, system_prompt, rubric_json, coding_json, current_version, created_at';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Accept integer minutes as number or numeric string; reject invalid / non-positive. */
function positiveDurationMinutes(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function asAdminRow(value: unknown): InterviewTemplateAdminRow | null {
  if (!isRecord(value)) return null;
  const id = value['id'];
  const slug = value['slug'];
  const title = value['title'];
  const kind = value['kind'];
  const duration = positiveDurationMinutes(value['duration_minutes']);
  const status = value['status'];
  const systemPrompt = value['system_prompt'];
  const rubric = value['rubric_json'];
  const currentVersion = positiveDurationMinutes(value['current_version']);
  const createdAt = value['created_at'];
  if (
    typeof id !== 'string' ||
    typeof slug !== 'string' ||
    typeof title !== 'string' ||
    typeof kind !== 'string' ||
    duration === null ||
    typeof status !== 'string' ||
    typeof systemPrompt !== 'string' ||
    currentVersion === null ||
    typeof createdAt !== 'string'
  ) {
    return null;
  }
  if (!TEMPLATE_KINDS.includes(kind as InterviewTemplateAdminKind)) return null;
  if (!TEMPLATE_STATUSES.includes(status as InterviewTemplateAdminStatus)) return null;
  if (!isRecord(rubric)) return null;
  return {
    id,
    slug,
    title,
    kind: kind as InterviewTemplateAdminKind,
    duration_minutes: duration,
    status: status as InterviewTemplateAdminStatus,
    system_prompt: systemPrompt,
    rubric_json: rubric,
    coding: parseInterviewCodingProblem(value['coding_json']),
    current_version: currentVersion,
    created_at: createdAt,
  };
}

function codingPayloadForKind(
  kind: InterviewTemplateAdminKind,
  coding: InterviewCodingProblem | null
): Record<string, unknown> | null {
  if (kind !== 'technical') return null;
  return toInterviewCodingJson(coding);
}

/** Admin UI label for the live template's current INT-009 snapshot number. */
export function interviewTemplateVersionLabel(
  row: Pick<InterviewTemplateAdminRow, 'current_version'>
): string {
  return `v${row.current_version}`;
}

@Injectable({ providedIn: 'root' })
export class AdminInterviewTemplatesService {
  async listTemplates(): Promise<InterviewTemplateAdminRow[]> {
    const { data, error } = await supabase
      .from('interview_templates')
      .select(ADMIN_SELECT)
      .order('title', { ascending: true });

    if (error) throw new Error(error.message);

    const rows: InterviewTemplateAdminRow[] = [];
    for (const item of data ?? []) {
      const row = asAdminRow(item);
      if (row) rows.push(row);
    }
    return rows;
  }

  async createTemplate(input: InterviewTemplateAdminCreateInput): Promise<InterviewTemplateAdminRow> {
    const { data, error } = await supabase
      .from('interview_templates')
      .insert({
        slug: input.slug.trim(),
        title: input.title.trim(),
        kind: input.kind,
        duration_minutes: input.duration_minutes,
        status: input.status,
        system_prompt: input.system_prompt.trim(),
        rubric_json: input.rubric_json,
        coding_json: codingPayloadForKind(input.kind, input.coding),
      })
      .select(ADMIN_SELECT)
      .single();

    if (error) throw new Error(error.message);
    const row = asAdminRow(data);
    if (!row) throw new Error('The interview template was not created.');
    return row;
  }

  async updateTemplate(
    id: string,
    input: InterviewTemplateAdminSaveInput
  ): Promise<InterviewTemplateAdminRow> {
    const { data, error } = await supabase
      .from('interview_templates')
      .update({
        title: input.title.trim(),
        kind: input.kind,
        duration_minutes: input.duration_minutes,
        status: input.status,
        system_prompt: input.system_prompt.trim(),
        rubric_json: input.rubric_json,
        coding_json: codingPayloadForKind(input.kind, input.coding),
      })
      .eq('id', id)
      .select(ADMIN_SELECT)
      .single();

    if (error) throw new Error(error.message);
    const row = asAdminRow(data);
    if (!row) throw new Error('The interview template was not saved.');
    return row;
  }
}
