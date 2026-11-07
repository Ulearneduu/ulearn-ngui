import { Injectable } from '@angular/core';
import { supabase } from '../../core/supabase.client';
import type {
  InterviewCompetencyScore,
  InterviewEvaluationStatus,
  InterviewOverrideTargetKind,
  InterviewReviewDetail,
  InterviewReviewQueueItem,
  InterviewScoreOverride,
  InterviewSessionStatus,
  InterviewTemplateKind,
  InterviewTurn,
} from '../../models';

@Injectable({ providedIn: 'root' })
export class AdminInterviewReviewsService {
  async listQueue(): Promise<InterviewReviewQueueItem[]> {
    const { data, error } = await supabase.rpc('list_interview_review_queue');
    if (error) throw error;
    return parseQueue(data);
  }

  async getDetail(sessionId: string): Promise<InterviewReviewDetail> {
    const { data, error } = await supabase.rpc('get_interview_review_detail', {
      p_session_id: sessionId,
    });
    if (error) throw error;
    const detail = parseDetail(data);
    if (!detail) throw new Error('Interview review details could not be loaded.');
    return detail;
  }

  async applyOverride(input: {
    sessionId: string;
    targetKind: InterviewOverrideTargetKind;
    competency: string | null;
    newScore: number;
    reason: string;
  }): Promise<void> {
    const { error } = await supabase.rpc('apply_interview_score_override', {
      p_session_id: input.sessionId,
      p_target_kind: input.targetKind,
      p_competency: input.targetKind === 'competency' ? input.competency : null,
      p_new_score: input.newScore,
      p_reason: input.reason,
    });
    if (error) throw error;
  }

  async setPublished(sessionId: string, published: boolean): Promise<void> {
    const { error } = await supabase.rpc('set_interview_mentor_review_published', {
      p_session_id: sessionId,
      p_published: published,
    });
    if (error) throw error;
  }
}

function parseQueue(value: unknown): InterviewReviewQueueItem[] {
  if (!Array.isArray(value)) return [];
  const rows: InterviewReviewQueueItem[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const sessionId = asString(item['sessionId']);
    const studentId = asString(item['studentId']);
    const templateId = asString(item['templateId']);
    const startedAt = asString(item['startedAt']);
    if (!sessionId || !studentId || !templateId || !startedAt) continue;
    const status = asString(item['status']);
    if (!status || !isSessionStatus(status)) continue;
    rows.push({
      sessionId,
      studentId,
      studentName: asString(item['studentName']) ?? 'Student',
      studentEmail: asString(item['studentEmail']),
      templateId,
      templateTitle: asString(item['templateTitle']) ?? 'Interview',
      templateKind: asKind(item['templateKind']),
      status,
      evaluationStatus: asEvalStatus(item['evaluationStatus']),
      evalVersion: asString(item['evalVersion']),
      aiOverallScore: finiteScore(item['aiOverallScore']),
      effectiveOverallScore: finiteScore(item['effectiveOverallScore']),
      mentorReviewPublished: item['mentorReviewPublished'] === true,
      startedAt,
      endedAt: asString(item['endedAt']),
      evaluatedAt: asString(item['evaluatedAt']),
    });
  }
  return rows;
}

function parseDetail(value: unknown): InterviewReviewDetail | null {
  if (!isRecord(value)) return null;
  const sessionId = asString(value['sessionId']);
  const promptVersion = asString(value['promptVersion']);
  const startedAt = asString(value['startedAt']);
  const status = asString(value['status']);
  if (!sessionId || !promptVersion || !startedAt || !status || !isSessionStatus(status)) return null;

  const studentRaw = value['student'];
  const templateRaw = value['template'];
  if (!isRecord(studentRaw) || !isRecord(templateRaw)) return null;
  const studentId = asString(studentRaw['id']);
  const templateId = asString(templateRaw['id']);
  if (!studentId || !templateId) return null;

  return {
    sessionId,
    student: {
      id: studentId,
      name: asString(studentRaw['name']) ?? 'Student',
      email: asString(studentRaw['email']),
    },
    template: {
      id: templateId,
      title: asString(templateRaw['title']) ?? 'Interview',
      kind: asKind(templateRaw['kind']),
      durationMinutes: finiteInt(templateRaw['durationMinutes']),
    },
    status,
    evaluationStatus: asEvalStatus(value['evaluationStatus']),
    evalVersion: asString(value['evalVersion']),
    promptVersion,
    startedAt,
    endedAt: asString(value['endedAt']),
    evaluatedAt: asString(value['evaluatedAt']),
    summary: asString(value['summary']),
    strengths: textList(value['strengths']),
    improvements: textList(value['improvements']),
    aiOverallScore: finiteScore(value['aiOverallScore']),
    effectiveOverallScore: finiteScore(value['effectiveOverallScore']),
    mentorReviewPublished: value['mentorReviewPublished'] === true,
    turns: parseTurns(value['turns']),
    aiCompetencies: parseCompetencies(value['aiCompetencies']),
    effectiveCompetencies: parseEffectiveCompetencies(value['effectiveCompetencies']),
    overrides: parseOverrides(value['overrides']),
  };
}

function parseTurns(value: unknown): InterviewTurn[] {
  if (!Array.isArray(value)) return [];
  const rows: InterviewTurn[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = asString(item['id']);
    const role = asString(item['role']);
    const content = asString(item['content']);
    const createdAt = asString(item['createdAt']);
    const seq = finiteInt(item['seq']);
    if (!id || (role !== 'user' && role !== 'assistant') || !content || !createdAt || seq === null) continue;
    rows.push({ id, role, content, seq, createdAt });
  }
  return rows.sort((a, b) => a.seq - b.seq);
}

function parseCompetencies(value: unknown): InterviewCompetencyScore[] {
  if (!Array.isArray(value)) return [];
  const rows: InterviewCompetencyScore[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const competency = asString(item['competency']);
    const score = finiteScore(item['score']);
    const feedback = asString(item['feedback']) ?? '';
    const evidence = asString(item['evidence']) ?? '';
    const evalVersion = asString(item['evalVersion']) ?? '';
    const id = asString(item['id']) ?? `${evalVersion}:${competency}`;
    if (!competency || score === null || !evalVersion) continue;
    rows.push({ id, competency, score, feedback, evidence, evalVersion });
  }
  return rows;
}

function parseEffectiveCompetencies(
  value: unknown
): InterviewReviewDetail['effectiveCompetencies'] {
  if (!Array.isArray(value)) return [];
  const rows: InterviewReviewDetail['effectiveCompetencies'] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const competency = asString(item['competency']);
    const aiScore = finiteScore(item['aiScore']);
    const effectiveScore = finiteScore(item['effectiveScore']);
    if (!competency || aiScore === null || effectiveScore === null) continue;
    rows.push({
      competency,
      aiScore,
      effectiveScore,
      feedback: asString(item['feedback']) ?? '',
      evidence: asString(item['evidence']) ?? '',
    });
  }
  return rows;
}

function parseOverrides(value: unknown): InterviewScoreOverride[] {
  if (!Array.isArray(value)) return [];
  const rows: InterviewScoreOverride[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const targetKind = asString(item['targetKind']);
    if (targetKind !== 'overall' && targetKind !== 'competency') continue;
    const id = asString(item['id']);
    const sessionId = asString(item['sessionId']);
    const mentorId = asString(item['mentorId']);
    const evalVersion = asString(item['evalVersion']);
    const reason = asString(item['reason']);
    const createdAt = asString(item['createdAt']);
    const oldScore = finiteScore(item['oldScore']);
    const newScore = finiteScore(item['newScore']);
    if (!id || !sessionId || !mentorId || !evalVersion || !reason || !createdAt) continue;
    if (oldScore === null || newScore === null) continue;
    const competency = asString(item['competency']);
    rows.push({
      id,
      sessionId,
      mentorId,
      mentorName: asString(item['mentorName']),
      targetKind,
      competency: targetKind === 'competency' ? competency : null,
      evalVersion,
      oldScore,
      newScore,
      reason,
      createdAt,
    });
  }
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function finiteScore(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return null;
  return Math.round(parsed * 100) / 100;
}

function finiteInt(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isInteger(parsed)) return null;
  return parsed;
}

function asKind(value: unknown): InterviewTemplateKind | string | null {
  return typeof value === 'string' ? value : null;
}

function asEvalStatus(value: unknown): InterviewEvaluationStatus | null {
  if (value === 'pending' || value === 'processing' || value === 'completed' || value === 'failed') {
    return value;
  }
  return null;
}

function isSessionStatus(value: string): value is InterviewSessionStatus {
  return value === 'in_progress' || value === 'completed' || value === 'failed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
