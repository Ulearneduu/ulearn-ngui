import { CrtCorrectIndex, CrtDifficulty, CrtModule, CrtQuestionInput } from './crt-admin.service';

export const QUESTION_IMPORT_HEADERS = [
  'module_title',
  'stem',
  'option_a',
  'option_b',
  'option_c',
  'option_d',
  'correct',
  'topic',
  'difficulty',
  'explanation',
] as const;

export type QuestionImportHeader = (typeof QUESTION_IMPORT_HEADERS)[number];

export const SAMPLE_QUESTION_ROW: Record<QuestionImportHeader, string> = {
  module_title: 'Aptitude',
  stem: 'SAMPLE - Delete this row. What is 15% of 200?',
  option_a: '20',
  option_b: '30',
  option_c: '35',
  option_d: '45',
  correct: 'B',
  topic: 'Percentages',
  difficulty: 'easy',
  explanation: '15% of 200 is 30. Delete this sample row before importing.',
};

export interface QuestionImportRowResult {
  rowNumber: number;
  stem: string;
  success: boolean;
  skipped: boolean;
  message: string;
}

export interface ParsedQuestionRow {
  rowNumber: number;
  values: Record<QuestionImportHeader, string>;
}

export interface PreparedQuestionRow {
  rowNumber: number;
  stem: string;
  input?: CrtQuestionInput;
  skipped?: boolean;
  error?: string;
}

const SAMPLE_PREFIX = 'SAMPLE -';

export function questionTemplateRows(): string[][] {
  return [
    [...QUESTION_IMPORT_HEADERS],
    QUESTION_IMPORT_HEADERS.map((header) => SAMPLE_QUESTION_ROW[header]),
  ];
}

export function questionInstructionRows(): string[][] {
  return [
    ['ULearn — CRT question import'],
    [''],
    ['Use the Questions sheet. The ten headers are required and may appear in any order.'],
    ['Delete the sample row before uploading. A question that starts with "SAMPLE -", in any letter case, is skipped and is not imported.'],
    ['Blank rows are ignored. Each other row is checked on its own.'],
    ['module_title must match one existing module title. Duplicate titles are rejected instead of guessing.'],
    ['correct must be A, B, C, or D. difficulty must be easy, medium, or hard.'],
    ['explanation may be left blank.'],
  ];
}

export function parseQuestionMatrix(matrix: unknown[][]): { rows: ParsedQuestionRow[]; error?: string } {
  if (matrix.length === 0 || matrix.every((row) => isBlank(row))) {
    return { rows: [], error: 'The file is empty.' };
  }

  const located = locateHeaders(matrix[0] ?? []);
  if ('error' in located) return { rows: [], error: located.error };

  const rows: ParsedQuestionRow[] = [];
  for (let index = 1; index < matrix.length; index++) {
    const cells = matrix[index] ?? [];
    if (isBlank(cells)) continue;
    const values = {} as Record<QuestionImportHeader, string>;
    for (const header of QUESTION_IMPORT_HEADERS) {
      values[header] = cellText(cells[located.positions[header]]);
    }
    rows.push({ rowNumber: index + 1, values });
  }

  if (rows.length === 0) {
    return { rows: [], error: 'The file has no question rows.' };
  }
  return { rows };
}

export function prepareQuestionRow(row: ParsedQuestionRow, modules: CrtModule[]): PreparedQuestionRow {
  const values = row.values;
  const stem = values.stem.trim();
  if (stem.toLowerCase().startsWith(SAMPLE_PREFIX.toLowerCase())) {
    return {
      rowNumber: row.rowNumber,
      stem,
      skipped: true,
      error: 'Sample row was skipped and was not imported.',
    };
  }

  const reasons: string[] = [];
  const module = resolveModule(values.module_title, modules);
  if ('error' in module) reasons.push(module.error);

  if (stem.length < 5) reasons.push('stem must contain at least 5 characters.');

  const options = [values.option_a, values.option_b, values.option_c, values.option_d].map((option) => option.trim());
  if (options.some((option) => option.length === 0)) {
    reasons.push('option_a, option_b, option_c, and option_d are required.');
  }

  const correct = normalizeCorrect(values.correct);
  if (correct === null) reasons.push('correct must be A, B, C, or D.');

  const topic = values.topic.trim();
  if (!topic) reasons.push('topic is required.');

  const difficulty = normalizeDifficulty(values.difficulty);
  if (difficulty === null) reasons.push('difficulty must be easy, medium, or hard.');

  if (reasons.length > 0 || !('id' in module) || correct === null || difficulty === null) {
    return {
      rowNumber: row.rowNumber,
      stem: stem || '—',
      error: reasons.join(' '),
    };
  }

  return {
    rowNumber: row.rowNumber,
    stem,
    input: {
      module_id: module.id,
      stem,
      options: options as [string, string, string, string],
      correct_index: correct,
      topic,
      difficulty,
      explanation: values.explanation.trim(),
    },
  };
}

function locateHeaders(
  cells: unknown[],
): { positions: Record<QuestionImportHeader, number> } | { error: string } {
  const positions = new Map<string, number>();
  const duplicates = new Set<string>();

  cells.forEach((cell, index) => {
    const name = normalizeHeader(cell);
    if (!name) return;
    if (positions.has(name)) duplicates.add(name);
    else positions.set(name, index);
  });

  const duplicateRequired = QUESTION_IMPORT_HEADERS.filter((header) => duplicates.has(header));
  const missing = QUESTION_IMPORT_HEADERS.filter((header) => !positions.has(header));
  const problems: string[] = [];
  if (missing.length > 0) problems.push(`Missing header: ${missing.join(', ')}.`);
  if (duplicateRequired.length > 0) problems.push(`Duplicate header: ${duplicateRequired.join(', ')}.`);
  if (problems.length > 0) return { error: problems.join(' ') };

  const located = {} as Record<QuestionImportHeader, number>;
  for (const header of QUESTION_IMPORT_HEADERS) {
    const position = positions.get(header);
    if (position === undefined) return { error: `Missing header: ${header}.` };
    located[header] = position;
  }
  return { positions: located };
}

function normalizeHeader(value: unknown): string {
  return cellText(value).replace(/^\uFEFF/, '').trim().toLowerCase();
}

function resolveModule(title: string, modules: CrtModule[]): { id: string } | { error: string } {
  const trimmed = title.trim();
  if (!trimmed) return { error: 'module_title is required.' };

  const exact = modules.filter((module) => module.title.trim() === trimmed);
  if (exact.length > 1) {
    return { error: `More than one module is titled "${trimmed}".` };
  }
  if (exact.length === 1) return { id: exact[0].id };

  const folded = modules.filter((module) => module.title.trim().toLowerCase() === trimmed.toLowerCase());
  if (folded.length > 1) {
    return { error: `More than one module matches "${trimmed}".` };
  }
  if (folded.length === 1) return { id: folded[0].id };
  return { error: `No module is titled "${trimmed}".` };
}

function normalizeCorrect(value: string): CrtCorrectIndex | null {
  const letter = value.trim().toUpperCase();
  if (letter === 'A') return 0;
  if (letter === 'B') return 1;
  if (letter === 'C') return 2;
  if (letter === 'D') return 3;
  return null;
}

function normalizeDifficulty(value: string): CrtDifficulty | null {
  const difficulty = value.trim().toLowerCase();
  if (difficulty === 'easy' || difficulty === 'medium' || difficulty === 'hard') return difficulty;
  return null;
}

function cellText(value: unknown): string {
  return String(value ?? '').trim();
}

function isBlank(row: unknown[]): boolean {
  return row.every((cell) => cellText(cell) === '');
}
