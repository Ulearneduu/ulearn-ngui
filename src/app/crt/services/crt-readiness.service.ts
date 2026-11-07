import { Injectable } from '@angular/core';
import { supabase } from '../../core/supabase.client';

export interface CrtReadinessScore {
  score: number;
  practiceAccuracy: number;
  latestMockScore: number;
  topicCoverage: number;
}

export interface CrtReadinessAttempt {
  kind: 'practice' | 'mock';
  submittedAt: string;
  score: number | null;
  maxScore: number | null;
}

const PRACTICE_ATTEMPT_LIMIT = 5;

@Injectable({ providedIn: 'root' })
export class CrtReadinessService {
  async getPathReadiness(pathId: string): Promise<CrtReadinessScore> {
    const userId = await this.requireUserId();
    const [attempts, moduleIds] = await Promise.all([
      this.listSubmittedAttempts(userId, pathId),
      this.listModuleIds(pathId),
    ]);

    const [questions, correctQuestionIds] = await Promise.all([
      this.listPathQuestions(moduleIds),
      this.listCorrectQuestionIds(attempts.map((attempt) => attempt.id)),
    ]);
    const topicByQuestion = new Map(questions.map((question) => [question.id, question.topic]));

    return calculateReadiness(
      attempts.map((attempt) => ({
        kind: attempt.kind,
        submittedAt: attempt.submittedAt,
        score: attempt.score,
        maxScore: attempt.maxScore,
      })),
      questions.map((question) => question.topic),
      correctQuestionIds.map((questionId) => topicByQuestion.get(questionId) ?? null),
    );
  }

  private async listSubmittedAttempts(userId: string, pathId: string): Promise<SubmittedAttempt[]> {
    const { data, error } = await supabase
      .from('crt_attempts')
      .select('id, kind, submitted_at, score, max_score')
      .eq('user_id', userId)
      .eq('path_id', pathId)
      .eq('status', 'submitted')
      .order('submitted_at', { ascending: false });

    if (error) throw new Error(error.message);

    const attempts: SubmittedAttempt[] = [];
    for (const row of data ?? []) {
      const kind = row.kind === 'practice' || row.kind === 'mock' ? row.kind : null;
      const submittedAt = typeof row.submitted_at === 'string' ? row.submitted_at : null;
      if (!kind || !submittedAt || typeof row.id !== 'string') continue;
      attempts.push({
        id: row.id,
        kind,
        submittedAt,
        score: finiteNumber(row.score),
        maxScore: finiteNumber(row.max_score),
      });
    }
    return attempts;
  }

  private async listModuleIds(pathId: string): Promise<string[]> {
    const { data, error } = await supabase
      .from('crt_modules')
      .select('id')
      .eq('path_id', pathId);

    if (error) throw new Error(error.message);
    return (data ?? []).flatMap((row) => (typeof row.id === 'string' ? [row.id] : []));
  }

  private async listPathQuestions(moduleIds: readonly string[]): Promise<PathQuestion[]> {
    if (moduleIds.length === 0) return [];

    const { data, error } = await supabase
      .from('crt_questions_student')
      .select('id, topic')
      .in('module_id', [...moduleIds]);

    if (error) throw new Error(error.message);
    return (data ?? []).flatMap((row) => (
      typeof row.id === 'string'
        ? [{ id: row.id, topic: typeof row.topic === 'string' ? row.topic : null }]
        : []
    ));
  }

  private async listCorrectQuestionIds(attemptIds: readonly string[]): Promise<string[]> {
    if (attemptIds.length === 0) return [];

    const { data, error } = await supabase
      .from('crt_attempt_answers')
      .select('question_id')
      .in('attempt_id', [...attemptIds])
      .eq('is_correct', true);

    if (error) throw new Error(error.message);
    return [...new Set((data ?? []).flatMap((row) => (
      typeof row.question_id === 'string' ? [row.question_id] : []
    )))];
  }

  private async requireUserId(): Promise<string> {
    const { data, error } = await supabase.auth.getUser();
    if (error) throw new Error(error.message);
    if (!data.user) throw new Error('Not signed in.');
    return data.user.id;
  }
}

interface SubmittedAttempt extends CrtReadinessAttempt {
  id: string;
}

interface PathQuestion {
  id: string;
  topic: string | null;
}

export function calculateReadiness(
  attempts: readonly CrtReadinessAttempt[],
  questionTopics: readonly (string | null)[],
  correctlyAnsweredTopics: readonly (string | null)[],
): CrtReadinessScore {
  const submitted = [...attempts].sort((left, right) => right.submittedAt.localeCompare(left.submittedAt));
  const practiceAccuracy = averagePracticeAccuracy(submitted);
  const latestMockScore = latestMockAccuracy(submitted);
  const topicCoverage = coveragePercent(questionTopics, correctlyAnsweredTopics);
  const raw = (0.4 * practiceAccuracy) + (0.4 * latestMockScore) + (0.2 * topicCoverage);

  return {
    score: clampPercent(Math.round(raw)),
    practiceAccuracy,
    latestMockScore,
    topicCoverage,
  };
}

function averagePracticeAccuracy(attempts: readonly CrtReadinessAttempt[]): number {
  const latest = attempts.filter((attempt) => attempt.kind === 'practice').slice(0, PRACTICE_ATTEMPT_LIMIT);
  const accuracies = latest.flatMap((attempt) => {
    const accuracy = accuracyPercent(attempt.score, attempt.maxScore);
    return accuracy === null ? [] : [accuracy];
  });
  if (accuracies.length === 0) return 0;
  const total = accuracies.reduce((sum, accuracy) => sum + accuracy, 0);
  return total / accuracies.length;
}

function latestMockAccuracy(attempts: readonly CrtReadinessAttempt[]): number {
  const latest = attempts.find((attempt) => attempt.kind === 'mock');
  if (!latest) return 0;
  return accuracyPercent(latest.score, latest.maxScore) ?? 0;
}

function coveragePercent(
  questionTopics: readonly (string | null)[],
  correctlyAnsweredTopics: readonly (string | null)[],
): number {
  const eligible = new Set(questionTopics.flatMap((topic) => {
    const name = topicName(topic);
    return name ? [name] : [];
  }));
  if (eligible.size === 0) return 0;

  const covered = new Set(correctlyAnsweredTopics.flatMap((topic) => {
    const name = topicName(topic);
    return name && eligible.has(name) ? [name] : [];
  }));
  return (covered.size / eligible.size) * 100;
}

function accuracyPercent(score: number | null, maxScore: number | null): number | null {
  if (score === null || maxScore === null || maxScore <= 0) return null;
  return clampPercent((score / maxScore) * 100);
}

function topicName(topic: string | null): string | null {
  const name = topic?.trim() ?? '';
  return name ? name : null;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}
