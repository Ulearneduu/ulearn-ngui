import { Injectable } from '@angular/core';
import { supabase } from '../../core/supabase.client';

export interface CrtPracticePath {
  id: string;
  title: string;
  description: string | null;
  status: 'published';
  created_at: string;
  updated_at: string;
}

export interface CrtPracticeModule {
  id: string;
  path_id: string;
  title: string;
  sort_order: number;
  created_at: string;
}

export interface CrtPracticeQuestion {
  id: string;
  module_id: string;
  stem: string;
  options: [string, string, string, string];
  topic: string | null;
  difficulty: 'easy' | 'medium' | 'hard' | null;
  created_at: string;
}

export interface CrtPracticeAttempt {
  id: string;
  user_id: string;
  path_id: string;
  module_id: string;
  kind: 'practice';
  status: 'in_progress' | 'submitted';
  started_at: string;
  submitted_at: string | null;
  duration_seconds: number;
  score: number | null;
  max_score: number | null;
}

export interface CrtSelectedAnswer {
  id: string;
  attempt_id: string;
  question_id: string;
  selected_index: 0 | 1 | 2 | 3 | null;
  answered_at: string;
}

export interface CrtAttemptSummary {
  id: string;
  path_id: string;
  module_id: string | null;
  status: 'in_progress' | 'submitted';
  started_at: string;
  submitted_at: string | null;
  duration_seconds: number;
  score: number | null;
  max_score: number | null;
}

export interface CrtAttemptScore {
  attempt_score: number;
  attempt_max_score: number;
}

export interface CrtAttemptReview {
  question_id: string;
  stem: string;
  options: [string, string, string, string];
  selected_index: 0 | 1 | 2 | 3 | null;
  correct_index: 0 | 1 | 2 | 3;
  explanation: string | null;
  is_correct: boolean | null;
}

type AttemptRow = {
  id: string;
  user_id: string;
  path_id: string;
  module_id: string | null;
  kind: string;
  status: string;
  started_at: string;
  submitted_at: string | null;
  duration_seconds: number | string;
  score: number | string | null;
  max_score: number | string | null;
};

const ATTEMPT_COLUMNS =
  'id, user_id, path_id, module_id, kind, status, started_at, submitted_at, duration_seconds, score, max_score';

const ATTEMPT_SUMMARY_COLUMNS =
  'id, path_id, module_id, status, started_at, submitted_at, duration_seconds, score, max_score';

@Injectable({ providedIn: 'root' })
export class CrtPracticeService {
  async listPublishedPaths(): Promise<CrtPracticePath[]> {
    const { data, error } = await supabase
      .from('crt_paths')
      .select('id, title, description, status, created_at, updated_at')
      .eq('status', 'published')
      .order('title', { ascending: true });

    if (error) throw new Error(error.message);
    return (data ?? []) as CrtPracticePath[];
  }

  async listModules(pathId: string): Promise<CrtPracticeModule[]> {
    await this.requirePublishedPath(pathId);

    const { data, error } = await supabase
      .from('crt_modules')
      .select('id, path_id, title, sort_order, created_at')
      .eq('path_id', pathId)
      .order('sort_order', { ascending: true });

    if (error) throw new Error(error.message);
    return (data ?? []) as CrtPracticeModule[];
  }

  async listQuestions(moduleId: string): Promise<CrtPracticeQuestion[]> {
    await this.requireModule(moduleId);

    const { data, error } = await supabase
      .from('crt_questions_student')
      .select('id, module_id, stem, options, topic, difficulty, created_at')
      .eq('module_id', moduleId)
      .order('created_at', { ascending: true });

    if (error) throw new Error(error.message);
    return (data ?? []).map((row) => this.toQuestion(row));
  }

  async findOrCreateAttempt(pathId: string, moduleId: string): Promise<CrtPracticeAttempt> {
    const userId = await this.requireUserId();
    await this.requireModuleOnPath(pathId, moduleId);

    const { data, error } = await supabase
      .from('crt_attempts')
      .select(ATTEMPT_COLUMNS)
      .eq('user_id', userId)
      .eq('path_id', pathId)
      .eq('module_id', moduleId)
      .eq('kind', 'practice')
      .eq('status', 'in_progress')
      .order('started_at', { ascending: false })
      .limit(1);

    if (error) throw new Error(error.message);
    const existing = data?.[0] as AttemptRow | undefined;
    if (existing) return this.toAttempt(existing);

    const { data: created, error: insertError } = await supabase
      .from('crt_attempts')
      .insert({
        user_id: userId,
        path_id: pathId,
        module_id: moduleId,
        kind: 'practice',
        status: 'in_progress',
      })
      .select(ATTEMPT_COLUMNS)
      .single();

    if (insertError) throw new Error(insertError.message);
    if (!created) throw new Error('Practice attempt was not created.');
    return this.toAttempt(created as AttemptRow);
  }

  async listSelectedAnswers(attemptId: string): Promise<CrtSelectedAnswer[]> {
    const attempt = await this.requireOwnedAttempt(attemptId);
    if (attempt.status !== 'in_progress') {
      throw new Error('Selected answers are available only while the attempt is in progress.');
    }

    const { data, error } = await supabase
      .from('crt_attempt_answers')
      .select('id, attempt_id, question_id, selected_index, answered_at')
      .eq('attempt_id', attemptId)
      .order('answered_at', { ascending: true });

    if (error) throw new Error(error.message);
    return (data ?? []).map((row) => this.toSelectedAnswer(row));
  }

  async saveAnswer(
    attemptId: string,
    questionId: string,
    selectedIndex: 0 | 1 | 2 | 3,
  ): Promise<CrtSelectedAnswer> {
    const attempt = await this.requireOwnedAttempt(attemptId);
    if (attempt.status !== 'in_progress') {
      throw new Error('This attempt has already been submitted.');
    }
    if (attempt.module_id !== null) {
      await this.requireQuestionInModule(questionId, attempt.module_id);
    }

    const answeredAt = new Date().toISOString();
    const { data: current, error: lookupError } = await supabase
      .from('crt_attempt_answers')
      .select('id')
      .eq('attempt_id', attemptId)
      .eq('question_id', questionId)
      .maybeSingle();

    if (lookupError) throw new Error(lookupError.message);

    if (current) {
      const { data, error } = await supabase
        .from('crt_attempt_answers')
        .update({
          selected_index: selectedIndex,
          answered_at: answeredAt,
        })
        .eq('id', current.id)
        .select('id, attempt_id, question_id, selected_index, answered_at')
        .single();

      if (error) throw new Error(error.message);
      if (!data) throw new Error('Selected answer was not saved.');
      return this.toSelectedAnswer(data);
    }

    const { data, error } = await supabase
      .from('crt_attempt_answers')
      .insert({
        attempt_id: attemptId,
        question_id: questionId,
        selected_index: selectedIndex,
        answered_at: answeredAt,
      })
      .select('id, attempt_id, question_id, selected_index, answered_at')
      .single();

    if (error) throw new Error(error.message);
    if (!data) throw new Error('Selected answer was not saved.');
    return this.toSelectedAnswer(data);
  }

  async submitAttempt(attemptId: string): Promise<CrtAttemptScore> {
    const attempt = await this.requireOwnedAttempt(attemptId);
    if (attempt.status !== 'in_progress') {
      throw new Error('This attempt has already been submitted.');
    }

    const { data, error } = await supabase.rpc('crt_submit_attempt', {
      target_attempt: attemptId,
    });

    if (error) throw new Error(error.message);
    const row = this.firstRow(data);
    if (!row) throw new Error('The database did not return an attempt score.');

    return {
      attempt_score: this.databaseNumber(row['attempt_score'], 'attempt_score'),
      attempt_max_score: this.databaseNumber(row['attempt_max_score'], 'attempt_max_score'),
    };
  }
  async listMyPracticeAttempts(): Promise<CrtAttemptSummary[]> {
    const userId = await this.requireUserId();

    const { data, error } = await supabase
      .from('crt_attempts')
      .select(ATTEMPT_SUMMARY_COLUMNS)
      .eq('user_id', userId)
      .eq('kind', 'practice')
      .order('started_at', { ascending: false });

    if (error) throw new Error(error.message);
    return (data ?? []).map((row) => this.toAttemptSummary(row));
  }

  async listMyAttempts(): Promise<CrtAttemptSummary[]> {
    const userId = await this.requireUserId();

    const { data, error } = await supabase
      .from('crt_attempts')
      .select(ATTEMPT_SUMMARY_COLUMNS)
      .eq('user_id', userId)
      .order('started_at', { ascending: false });

    if (error) throw new Error(error.message);
    return (data ?? []).map((row) => this.toAttemptSummary(row));
  }

  async getMySubmittedAttempt(attemptId: string): Promise<CrtAttemptSummary> {
    const userId = await this.requireUserId();
    const { data, error } = await supabase
      .from('crt_attempts')
      .select(ATTEMPT_SUMMARY_COLUMNS)
      .eq('id', attemptId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) throw new Error('Practice attempt not found.');

    const attempt = this.toAttemptSummary(data);
    if (attempt.status !== 'submitted') {
      throw new Error('This attempt has not been submitted.');
    }
    return attempt;
  }

  async reviewAttempt(attemptId: string): Promise<CrtAttemptReview[]> {
    const attempt = await this.requireOwnedAttempt(attemptId);
    if (attempt.status !== 'submitted') {
      throw new Error('Review is available only after the attempt is submitted.');
    }

    const { data, error } = await supabase.rpc('crt_attempt_review', {
      target_attempt: attemptId,
    });

    if (error) throw new Error(error.message);
    return (Array.isArray(data) ? data : []).map((row) => this.toReview(row));
  }

  private async requireUserId(): Promise<string> {
    const { data, error } = await supabase.auth.getUser();
    if (error) throw new Error(error.message);
    if (!data.user) throw new Error('Not signed in.');
    return data.user.id;
  }

  private async requirePublishedPath(pathId: string): Promise<void> {
    const { data, error } = await supabase
      .from('crt_paths')
      .select('id')
      .eq('id', pathId)
      .eq('status', 'published')
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) throw new Error('Published path not found.');
  }

  private async requireModule(moduleId: string): Promise<{ id: string; path_id: string }> {
    const { data, error } = await supabase
      .from('crt_modules')
      .select('id, path_id')
      .eq('id', moduleId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) throw new Error('Module not found.');
    return data as { id: string; path_id: string };
  }

  private async requireModuleOnPath(pathId: string, moduleId: string): Promise<void> {
    await this.requirePublishedPath(pathId);
    const module = await this.requireModule(moduleId);
    if (module.path_id !== pathId) {
      throw new Error('Module does not belong to the selected path.');
    }
  }

  private async requireQuestionInModule(questionId: string, moduleId: string): Promise<void> {
    const { data, error } = await supabase
      .from('crt_questions_student')
      .select('id')
      .eq('id', questionId)
      .eq('module_id', moduleId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) throw new Error('Question not found in this module.');
  }

  private async requireOwnedAttempt(attemptId: string): Promise<CrtPracticeAttempt> {
    const userId = await this.requireUserId();
    const { data, error } = await supabase
      .from('crt_attempts')
      .select(ATTEMPT_COLUMNS)
      .eq('id', attemptId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) throw new Error('Practice attempt not found.');
    return this.toAttempt(data as AttemptRow);
  }

  private toQuestion(row: unknown): CrtPracticeQuestion {
    const record = this.record(row);
    const difficulty = record['difficulty'];
    return {
      id: this.text(record['id'], 'question id'),
      module_id: this.text(record['module_id'], 'module id'),
      stem: this.text(record['stem'], 'question stem'),
      options: this.options(record['options']),
      topic: this.nullableText(record['topic']),
      difficulty:
        difficulty === 'easy' || difficulty === 'medium' || difficulty === 'hard'
          ? difficulty
          : null,
      created_at: this.text(record['created_at'], 'created_at'),
    };
  }

  private toAttempt(row: AttemptRow): CrtPracticeAttempt {
    if (row.kind !== 'practice') throw new Error('Attempt is not a practice attempt.');
    if (row.status !== 'in_progress' && row.status !== 'submitted') {
      throw new Error('Attempt status is not recognized.');
    }
    if (!row.module_id) throw new Error('Practice attempt is missing its module.');

    return {
      id: row.id,
      user_id: row.user_id,
      path_id: row.path_id,
      module_id: row.module_id,
      kind: 'practice',
      status: row.status,
      started_at: row.started_at,
      submitted_at: row.submitted_at,
      duration_seconds: this.databaseNumber(row.duration_seconds, 'duration_seconds'),
      score: row.score === null ? null : this.databaseNumber(row.score, 'score'),
      max_score: row.max_score === null ? null : this.databaseNumber(row.max_score, 'max_score'),
    };
  }

  private toAttemptSummary(row: unknown): CrtAttemptSummary {
    const record = this.record(row);
    const status = record['status'];
    if (status !== 'in_progress' && status !== 'submitted') {
      throw new Error('Attempt status is not recognized.');
    }

    const score = record['score'];
    const maxScore = record['max_score'];
    return {
      id: this.text(record['id'], 'attempt id'),
      path_id: this.text(record['path_id'], 'path id'),
      module_id: this.nullableText(record['module_id']),
      status,
      started_at: this.text(record['started_at'], 'started_at'),
      submitted_at: this.nullableText(record['submitted_at']),
      duration_seconds: this.databaseNumber(record['duration_seconds'], 'duration_seconds'),
      score: score === null ? null : this.databaseNumber(score, 'score'),
      max_score: maxScore === null ? null : this.databaseNumber(maxScore, 'max_score'),
    };
  }

  private toSelectedAnswer(row: unknown): CrtSelectedAnswer {
    const record = this.record(row);
    return {
      id: this.text(record['id'], 'answer id'),
      attempt_id: this.text(record['attempt_id'], 'attempt id'),
      question_id: this.text(record['question_id'], 'question id'),
      selected_index: this.selectedIndex(record['selected_index']),
      answered_at: this.text(record['answered_at'], 'answered_at'),
    };
  }

  private toReview(row: unknown): CrtAttemptReview {
    const record = this.record(row);
    const correctIndex = this.selectedIndex(record['correct_index']);
    if (correctIndex === null) throw new Error('Review did not include the correct answer.');

    return {
      question_id: this.text(record['question_id'], 'question id'),
      stem: this.text(record['stem'], 'question stem'),
      options: this.options(record['options']),
      selected_index: this.selectedIndex(record['selected_index']),
      correct_index: correctIndex,
      explanation: this.nullableText(record['explanation']),
      is_correct: record['is_correct'] === null ? null : record['is_correct'] === true,
    };
  }

  private options(value: unknown): [string, string, string, string] {
    if (!Array.isArray(value) || value.length !== 4 || value.some((option) => typeof option !== 'string' || option.trim() === '')) {
      throw new Error('Question options are incomplete.');
    }
    return [value[0], value[1], value[2], value[3]];
  }

  private selectedIndex(value: unknown): 0 | 1 | 2 | 3 | null {
    if (value === null || value === undefined) return null;
    const index = typeof value === 'number' ? value : Number(value);
    if (index === 0 || index === 1 || index === 2 || index === 3) return index;
    throw new Error('Selected answer is outside the allowed options.');
  }

  private databaseNumber(value: unknown, label: string): number {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    if (!Number.isFinite(parsed)) throw new Error(`Database did not return ${label}.`);
    return parsed;
  }

  private firstRow(data: unknown): Record<string, unknown> | null {
    if (Array.isArray(data)) {
      return data.length > 0 ? this.record(data[0]) : null;
    }
    if (data && typeof data === 'object') return this.record(data);
    return null;
  }

  private record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Database returned an unexpected record.');
    }
    return value as Record<string, unknown>;
  }

  private text(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`Database did not return ${label}.`);
    }
    return value;
  }

  private nullableText(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  }
}
