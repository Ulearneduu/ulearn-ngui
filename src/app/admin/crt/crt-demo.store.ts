import { Injectable, signal } from '@angular/core';

/** In-memory demonstration records. Nothing here is written to Supabase. */

export type CrtContentStatus = 'draft' | 'published';
export type CrtAssignmentStatus = 'draft' | 'active';
export type CrtDifficulty = 'easy' | 'medium' | 'hard';
export type CrtAnswer = 'A' | 'B' | 'C' | 'D';

export interface CrtPath {
  id: string;
  title: string;
  description: string;
  displayOrder: number;
  status: CrtContentStatus;
}

export interface CrtModule {
  id: string;
  pathId: string;
  title: string;
  description: string;
  displayOrder: number;
  status: CrtContentStatus;
}

export interface CrtQuestion {
  id: string;
  moduleId: string;
  text: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
  correct: CrtAnswer;
  topic: string;
  difficulty: CrtDifficulty;
  status: CrtContentStatus;
}

export interface CrtBatchOption {
  id: string;
  name: string;
}

export interface CrtAssignment {
  id: string;
  batchId: string;
  pathId: string;
  assignedDate: string;
  dueDate: string;
  status: CrtAssignmentStatus;
}

export type CrtPathInput = Omit<CrtPath, 'id'>;
export type CrtModuleInput = Omit<CrtModule, 'id'>;
export type CrtQuestionInput = Omit<CrtQuestion, 'id'>;
export type CrtAssignmentInput = Omit<CrtAssignment, 'id'>;

const SEED_PATHS: CrtPath[] = [
  {
    id: 'path-aptitude',
    title: 'Aptitude Preparation',
    description: 'Quantitative aptitude, data interpretation, and speed practice.',
    displayOrder: 1,
    status: 'published'
  },
  {
    id: 'path-logical',
    title: 'Logical Reasoning',
    description: 'Puzzles, series, coding, and analytical reasoning.',
    displayOrder: 2,
    status: 'published'
  },
  {
    id: 'path-verbal',
    title: 'Verbal Ability',
    description: 'Grammar, reading comprehension, and vocabulary.',
    displayOrder: 3,
    status: 'draft'
  }
];

const SEED_MODULES: CrtModule[] = [
  {
    id: 'mod-series',
    pathId: 'path-logical',
    title: 'Number Series',
    description: 'Number patterns and sequences',
    displayOrder: 1,
    status: 'published'
  },
  {
    id: 'mod-coding',
    pathId: 'path-logical',
    title: 'Coding-Decoding',
    description: 'Letter and number coding',
    displayOrder: 2,
    status: 'draft'
  },
  {
    id: 'mod-blood',
    pathId: 'path-logical',
    title: 'Blood Relations',
    description: 'Family relationship problems',
    displayOrder: 3,
    status: 'published'
  }
];

const SEED_QUESTIONS: CrtQuestion[] = [
  {
    id: 'q-series-next',
    moduleId: 'mod-series',
    text: 'What comes next: 2, 4, 6, 8, ?',
    optionA: '9',
    optionB: '10',
    optionC: '12',
    optionD: '14',
    correct: 'B',
    topic: 'Sequences',
    difficulty: 'easy',
    status: 'published'
  },
  {
    id: 'q-series-odd',
    moduleId: 'mod-series',
    text: 'Find the odd one out: 2, 3, 5, 9',
    optionA: '2',
    optionB: '3',
    optionC: '5',
    optionD: '9',
    correct: 'D',
    topic: 'Number patterns',
    difficulty: 'medium',
    status: 'draft'
  },
  {
    id: 'q-coding-dog',
    moduleId: 'mod-coding',
    text: 'If CAT is coded as DBU, how is DOG coded?',
    optionA: 'EPH',
    optionB: 'FQI',
    optionC: 'EPI',
    optionD: 'DPH',
    correct: 'A',
    topic: 'Letter coding',
    difficulty: 'easy',
    status: 'published'
  }
];

const SEED_BATCHES: CrtBatchOption[] = [
  { id: 'batch-cse', name: 'CSE 2027' },
  { id: 'batch-ece', name: 'ECE 2027' },
  { id: 'batch-it', name: 'IT 2027' },
  { id: 'batch-mech', name: 'MECH 2027' }
];

const SEED_ASSIGNMENTS: CrtAssignment[] = [
  {
    id: 'asg-cse',
    batchId: 'batch-cse',
    pathId: 'path-aptitude',
    assignedDate: '2026-10-24',
    dueDate: '2026-11-30',
    status: 'active'
  },
  {
    id: 'asg-ece',
    batchId: 'batch-ece',
    pathId: 'path-logical',
    assignedDate: '2026-10-24',
    dueDate: '2026-11-15',
    status: 'active'
  },
  {
    id: 'asg-it',
    batchId: 'batch-it',
    pathId: 'path-verbal',
    assignedDate: '2026-10-24',
    dueDate: '2026-12-20',
    status: 'draft'
  }
];

@Injectable({ providedIn: 'root' })
export class CrtDemoStore {
  private readonly _paths = signal<CrtPath[]>(SEED_PATHS);
  private readonly _modules = signal<CrtModule[]>(SEED_MODULES);
  private readonly _questions = signal<CrtQuestion[]>(SEED_QUESTIONS);
  private readonly _batches = signal<CrtBatchOption[]>(SEED_BATCHES);
  private readonly _assignments = signal<CrtAssignment[]>(SEED_ASSIGNMENTS);
  private readonly _selectedPathId = signal('path-logical');

  readonly paths = this._paths.asReadonly();
  readonly modules = this._modules.asReadonly();
  readonly questions = this._questions.asReadonly();
  readonly batches = this._batches.asReadonly();
  readonly assignments = this._assignments.asReadonly();
  readonly selectedPathId = this._selectedPathId.asReadonly();

  selectPath(id: string): void {
    this._selectedPathId.set(id);
  }

  pathById(id: string): CrtPath | undefined {
    return this._paths().find((path) => path.id === id);
  }

  moduleById(id: string): CrtModule | undefined {
    return this._modules().find((module) => module.id === id);
  }

  questionById(id: string): CrtQuestion | undefined {
    return this._questions().find((question) => question.id === id);
  }

  assignmentById(id: string): CrtAssignment | undefined {
    return this._assignments().find((assignment) => assignment.id === id);
  }

  pathTitle(id: string): string {
    return this.pathById(id)?.title ?? 'Unknown path';
  }

  moduleTitle(id: string): string {
    return this.moduleById(id)?.title ?? 'Unknown module';
  }

  batchName(id: string): string {
    return this._batches().find((batch) => batch.id === id)?.name ?? 'Unknown batch';
  }

  moduleCount(pathId: string): number {
    return this._modules().filter((module) => module.pathId === pathId).length;
  }

  questionCount(moduleId: string): number {
    return this._questions().filter((question) => question.moduleId === moduleId).length;
  }

  nextPathOrder(): number {
    return this._paths().reduce((max, path) => Math.max(max, path.displayOrder), 0) + 1;
  }

  nextModuleOrder(pathId: string): number {
    return this._modules()
      .filter((module) => module.pathId === pathId)
      .reduce((max, module) => Math.max(max, module.displayOrder), 0) + 1;
  }

  createPath(input: CrtPathInput): CrtPath {
    const created: CrtPath = { ...input, id: crypto.randomUUID() };
    this._paths.update((list) => [...list, created]);
    return created;
  }

  updatePath(id: string, input: CrtPathInput): boolean {
    return this.replace(this._paths, id, input);
  }

  createModule(input: CrtModuleInput): CrtModule {
    const created: CrtModule = { ...input, id: crypto.randomUUID() };
    this._modules.update((list) => [...list, created]);
    return created;
  }

  updateModule(id: string, input: CrtModuleInput): boolean {
    return this.replace(this._modules, id, input);
  }

  moveModule(pathId: string, moduleId: string, direction: -1 | 1): boolean {
    const ordered = this._modules()
      .filter((module) => module.pathId === pathId)
      .sort((a, b) => a.displayOrder - b.displayOrder);
    const index = ordered.findIndex((module) => module.id === moduleId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ordered.length) return false;
    const current = ordered[index];
    const neighbor = ordered[target];
    this._modules.update((list) => list.map((module) => {
      if (module.id === current.id) return { ...module, displayOrder: neighbor.displayOrder };
      if (module.id === neighbor.id) return { ...module, displayOrder: current.displayOrder };
      return module;
    }));
    return true;
  }

  createQuestion(input: CrtQuestionInput): CrtQuestion {
    const created: CrtQuestion = { ...input, id: crypto.randomUUID() };
    this._questions.update((list) => [...list, created]);
    return created;
  }

  updateQuestion(id: string, input: CrtQuestionInput): boolean {
    return this.replace(this._questions, id, input);
  }

  deleteQuestion(id: string): void {
    this._questions.update((list) => list.filter((question) => question.id !== id));
  }

  createAssignment(input: CrtAssignmentInput): CrtAssignment {
    const created: CrtAssignment = { ...input, id: crypto.randomUUID() };
    this._assignments.update((list) => [...list, created]);
    return created;
  }

  updateAssignment(id: string, input: CrtAssignmentInput): boolean {
    return this.replace(this._assignments, id, input);
  }

  deleteAssignment(id: string): void {
    this._assignments.update((list) => list.filter((assignment) => assignment.id !== id));
  }

  private replace<T extends { id: string }>(
    source: { update: (fn: (list: T[]) => T[]) => void },
    id: string,
    input: Omit<T, 'id'>
  ): boolean {
    let found = false;
    source.update((list) => list.map((item) => {
      if (item.id !== id) return item;
      found = true;
      return { ...item, ...input, id };
    }));
    return found;
  }
}
