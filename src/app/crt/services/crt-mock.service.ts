
import { Injectable } from '@angular/core';
import { supabase } from '../../core/supabase.client';

export interface CrtMockQuestion {
  question_id: string;
  module_id: string;
  module_title: string;
  stem: string;
  options: [string, string, string, string];
  topic: string | null;
  difficulty: 'easy' | 'medium' | 'hard' | null;
  section_order: number;
  question_order: number;
  expires_at: string;
}

export interface CrtMockAnswer {
  id: string;
  attempt_id: string;
  question_id: string;
  selected_index: 0 | 1 | 2 | 3 | null;
  answered_at: string;
}

export interface CrtMockAttempt {
  mock_attempt_id: string;
  mock_expires_at: string;
}

export interface CrtMockScore {
  attempt_score: number;
  attempt_max_score: number;
}

export interface CrtMockResultSection {
  section_order: number;
  module_id: string;
  module_title: string;
  section_score: number;
  section_max_score: number;
}

@Injectable({ providedIn: 'root' })
export class CrtMockService {
  async startMockAttempt(pathId: string): Promise<CrtMockAttempt> {
    const { data, error } = await supabase.rpc('crt_start_mock_attempt', {
      target_path: pathId,
    });

    if (error) throw new Error(error.message);

    const row = this.firstRow(data);
    if (!row) throw new Error('Mock attempt was not created.');

    return {
      mock_attempt_id: this.text(row['mock_attempt_id']),
      mock_expires_at: this.text(row['mock_expires_at']),
    };
  }

  async getMockQuestions(attemptId: string): Promise<CrtMockQuestion[]> {
    const { data, error } = await supabase.rpc('crt_get_mock_questions', {
      target_attempt: attemptId,
    });

    if (error) throw new Error(error.message);

    return (Array.isArray(data) ? data : []).map(row => {
      const item = row as Record<string, unknown>;

      return {
        question_id: this.text(item['question_id']),
        module_id: this.text(item['module_id']),
        module_title: this.text(item['module_title']),
        stem: this.text(item['stem']),
        options: this.options(item['options']),
        topic: this.nullableText(item['topic']),
        difficulty: this.difficulty(item['difficulty']),
        section_order: Number(item['section_order']),
        question_order: Number(item['question_order']),
        expires_at: this.text(item['expires_at']),
      };
    });
  }

  async listAnswers(attemptId: string): Promise<CrtMockAnswer[]> {
    const { data, error } = await supabase
      .from('crt_attempt_answers')
      .select('id, attempt_id, question_id, selected_index, answered_at')
      .eq('attempt_id', attemptId);

    if (error) throw new Error(error.message);

    return (data ?? []).map(row => ({
      id: row.id,
      attempt_id: row.attempt_id,
      question_id: row.question_id,
      selected_index: this.selectedIndex(row.selected_index),
      answered_at: row.answered_at,
    }));
  }

  async saveAnswer(
    attemptId: string,
    questionId: string,
    selectedIndex: 0 | 1 | 2 | 3,
  ): Promise<void> {
    const { error } = await supabase
      .from('crt_attempt_answers')
      .upsert(
        {
          attempt_id: attemptId,
          question_id: questionId,
          selected_index: selectedIndex,
          answered_at: new Date().toISOString(),
        },
        { onConflict: 'attempt_id,question_id' },
      );

    if (error) throw new Error(error.message);
  }

  async submitMockAttempt(attemptId: string): Promise<CrtMockScore> {
    const { data, error } = await supabase.rpc(
      'crt_submit_mock_attempt',
      { target_attempt: attemptId },
    );

    if (error) throw new Error(error.message);

    const row = this.firstRow(data);
    if (!row) throw new Error('Mock score was not returned.');

    return {
      attempt_score: Number(row['attempt_score']),
      attempt_max_score: Number(row['attempt_max_score']),
    };
  }

  async getSectionResults(
    attemptId: string,
  ): Promise<CrtMockResultSection[]> {
    const { data, error } = await supabase.rpc(
      'crt_mock_result_sections',
      { target_attempt: attemptId },
    );

    if (error) throw new Error(error.message);

    return (Array.isArray(data) ? data : []).map(row => {
      const item = row as Record<string, unknown>;

      return {
        section_order: Number(item['section_order']),
        module_id: this.text(item['module_id']),
        module_title: this.text(item['module_title']),
        section_score: Number(item['section_score']),
        section_max_score: Number(item['section_max_score']),
      };
    });
  }

  private firstRow(data: unknown): Record<string, unknown> | null {
    const value = Array.isArray(data) ? data[0] : data;

    if (!value || typeof value !== 'object') return null;
    return value as Record<string, unknown>;
  }

  private text(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error('Database returned an invalid text value.');
    }
    return value;
  }

  private nullableText(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
  }

  private options(value: unknown): [string, string, string, string] {
    if (
      !Array.isArray(value) ||
      value.length !== 4 ||
      value.some(option => typeof option !== 'string')
    ) {
      throw new Error('Mock question options are invalid.');
    }

    return [value[0], value[1], value[2], value[3]];
  }

  private difficulty(
    value: unknown,
  ): 'easy' | 'medium' | 'hard' | null {
    return value === 'easy' || value === 'medium' || value === 'hard'
      ? value
      : null;
  }

  private selectedIndex(value: unknown): 0 | 1 | 2 | 3 | null {
    if (value === null || value === undefined) return null;

    const index = Number(value);

    if (index === 0 || index === 1 || index === 2 || index === 3) {
      return index;
    }

    throw new Error('Invalid selected answer.');
  }
}
