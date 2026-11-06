
import { Injectable } from '@angular/core';
import { supabase } from '../../core/supabase.client';

export interface CrtPath {
  id: string;
  title: string;
  description: string | null;
  status: 'draft' | 'published';
  created_at: string;
  updated_at: string;
}

export interface CrtModule {
  id: string;
  path_id: string;
  title: string;
  sort_order: number;
  created_at: string;
}

export type CrtDifficulty = 'easy' | 'medium' | 'hard';
export type CrtCorrectIndex = 0 | 1 | 2 | 3;

export interface CrtQuestion {
  id: string;
  module_id: string;
  stem: string;
  options: [string, string, string, string];
  correct_index: CrtCorrectIndex;
  topic: string | null;
  difficulty: CrtDifficulty | null;
  explanation: string | null;
  created_at: string;
}

export interface CrtQuestionInput {
  module_id: string;
  stem: string;
  options: [string, string, string, string];
  correct_index: CrtCorrectIndex;
  topic?: string | null;
  difficulty?: CrtDifficulty | null;
  explanation?: string | null;
}
export interface CrtMockBlueprint {
  id: string;
  path_id: string;
  total_minutes: number;
  created_at: string;
  updated_at: string;
}

export interface CrtMockBlueprintSection {
  id: string;
  blueprint_id: string;
  path_id: string;
  module_id: string;
  question_count: number;
  sort_order: number;
}

export interface CrtMockBlueprintConfig {
  blueprint: CrtMockBlueprint | null;
  sections: CrtMockBlueprintSection[];
}
@Injectable({
  providedIn: 'root',
})
export class CrtAdminService {
  async listPaths(): Promise<CrtPath[]> {
    const { data, error } = await supabase
      .from('crt_paths')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    return (data ?? []) as CrtPath[];
  }

  async createPath(input: {
    title: string;
    description?: string;
  }): Promise<CrtPath> {
    const { data, error } = await supabase
      .from('crt_paths')
      .insert({
        title: input.title.trim(),
        description: input.description?.trim() || null,
        status: 'draft',
      })
      .select('*')
      .single();

    if (error) throw new Error(error.message);
    return data as CrtPath;
  }

  async updatePath(
    id: string,
    input: {
      title: string;
      description?: string;
      status: 'draft' | 'published';
    },
  ): Promise<CrtPath> {
    const { data, error } = await supabase
      .from('crt_paths')
      .update({
        title: input.title.trim(),
        description: input.description?.trim() || null,
        status: input.status,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw new Error(error.message);
    return data as CrtPath;
  }

  async listModules(pathId: string): Promise<CrtModule[]> {
    const { data, error } = await supabase
      .from('crt_modules')
      .select('*')
      .eq('path_id', pathId)
      .order('sort_order', { ascending: true });

    if (error) throw new Error(error.message);
    return (data ?? []) as CrtModule[];
  }
  async getMockBlueprint(pathId: string): Promise<CrtMockBlueprintConfig> {
    const { data: blueprint, error: blueprintError } = await supabase
      .from('crt_mock_blueprints')
      .select('*')
      .eq('path_id', pathId)
      .maybeSingle();

    if (blueprintError) throw new Error(blueprintError.message);

    if (!blueprint) {
      return { blueprint: null, sections: [] };
    }

    const { data: sections, error: sectionsError } = await supabase
      .from('crt_mock_blueprint_sections')
      .select('*')
      .eq('blueprint_id', blueprint.id)
      .order('sort_order', { ascending: true });

    if (sectionsError) throw new Error(sectionsError.message);

    return {
      blueprint: blueprint as CrtMockBlueprint,
      sections: (sections ?? []) as CrtMockBlueprintSection[],
    };
  }

  async saveMockBlueprint(
    pathId: string,
    totalMinutes: number,
    sections: Array<{
      module_id: string;
      question_count: number;
      sort_order: number;
    }>,
  ): Promise<void> {
    const { error } = await supabase.rpc('crt_save_mock_blueprint', {
      target_path: pathId,
      target_minutes: totalMinutes,
      target_sections: sections,
    });

    if (error) throw new Error(error.message);
  }
  async createModule(
    pathId: string,
    title: string,
    sortOrder: number,
  ): Promise<CrtModule> {
    const { data, error } = await supabase
      .from('crt_modules')
      .insert({
        path_id: pathId,
        title: title.trim(),
        sort_order: sortOrder,
      })
      .select('*')
      .single();

    if (error) throw new Error(error.message);
    return data as CrtModule;
  }

  async updateModule(
    id: string,
    input: {
      title: string;
      sort_order: number;
    },
  ): Promise<CrtModule> {
    const { data, error } = await supabase
      .from('crt_modules')
      .update({
        title: input.title.trim(),
        sort_order: input.sort_order,
      })
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw new Error(error.message);
    return data as CrtModule;
  }

  async reorderModules(
    modules: Array<{ id: string; sort_order: number }>,
  ): Promise<void> {
    for (const module of modules) {
      const { error } = await supabase
        .from('crt_modules')
        .update({ sort_order: module.sort_order })
        .eq('id', module.id);

      if (error) throw new Error(error.message);
    }
  }

  async listQuestions(): Promise<CrtQuestion[]> {
    const { data, error } = await supabase
      .from('crt_questions_staff')
      .select('id, module_id, stem, options, correct_index, topic, difficulty, explanation, created_at')
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    return (data ?? []) as CrtQuestion[];
  }

  async listQuestionModules(): Promise<CrtModule[]> {
    const { data, error } = await supabase
      .from('crt_modules')
      .select('*')
      .order('sort_order', { ascending: true });

    if (error) throw new Error(error.message);
    return (data ?? []) as CrtModule[];
  }

  async createQuestion(input: CrtQuestionInput): Promise<CrtQuestion> {
    const { data, error } = await supabase
      .from('crt_questions_staff')
      .insert(this.questionPayload(input))
      .select('id, module_id, stem, options, correct_index, topic, difficulty, explanation, created_at')
      .single();

    if (error) throw new Error(error.message);
    return data as CrtQuestion;
  }

  async updateQuestion(id: string, input: CrtQuestionInput): Promise<CrtQuestion> {
    const { data, error } = await supabase
      .from('crt_questions_staff')
      .update(this.questionPayload(input))
      .eq('id', id)
      .select('id, module_id, stem, options, correct_index, topic, difficulty, explanation, created_at')
      .single();

    if (error) throw new Error(error.message);
    return data as CrtQuestion;
  }

  async deleteQuestion(id: string): Promise<void> {
    const { error } = await supabase
      .from('crt_questions_staff')
      .delete()
      .eq('id', id);

    if (error) throw new Error(error.message);
  }

  private questionPayload(input: CrtQuestionInput) {
    return {
      module_id: input.module_id,
      stem: input.stem.trim(),
      options: input.options.map((option) => option.trim()) as [string, string, string, string],
      correct_index: input.correct_index,
      topic: input.topic?.trim() || null,
      difficulty: input.difficulty ?? null,
      explanation: input.explanation?.trim() || null,
    };
  }
}
