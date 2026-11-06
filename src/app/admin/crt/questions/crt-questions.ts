import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  computed,
  inject,
  signal,
  viewChild
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AbstractControl, FormBuilder, ReactiveFormsModule, ValidationErrors, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ConfirmDialogService } from '../../../core/services/confirm-dialog.service';
import { ToastService } from '../../../core/services/toast';
import {
  CrtAdminService,
  CrtCorrectIndex,
  CrtDifficulty,
  CrtModule,
  CrtPath,
  CrtQuestion,
  CrtQuestionInput
} from '../../services/crt-admin.service';
import { CrtShell } from '../crt-shell/crt-shell';
import { CrtQuestionBulkImportService } from '../../services/crt-question-bulk-import.service';
import { QuestionImportRowResult } from '../../services/crt-question-bulk-import.util';

type CrtAnswer = 'A' | 'B' | 'C' | 'D';

const ANSWERS: CrtAnswer[] = ['A', 'B', 'C', 'D'];

function trimmedMinLength(min: number) {
  return (control: AbstractControl): ValidationErrors | null => {
    const value = String(control.value ?? '').trim();
    return value.length >= min ? null : { minlength: { requiredLength: min, actualLength: value.length } };
  };
}

interface QuestionView {
  id: string;
  moduleId: string;
  text: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
  correct: CrtAnswer;
  topic: string;
  difficulty: CrtDifficulty | null;
  explanation: string;
}

@Component({
  selector: 'app-crt-questions',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, CrtShell],
  templateUrl: './crt-questions.html',
  styleUrl: '../crt-admin.scss'
})
export class CrtQuestions implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly crtService = inject(CrtAdminService);
  private readonly bulkImport = inject(CrtQuestionBulkImportService);

  readonly answers: CrtAnswer[] = ANSWERS;
  readonly difficulties: { id: CrtDifficulty; label: string }[] = [
    { id: 'easy', label: 'Easy' },
    { id: 'medium', label: 'Medium' },
    { id: 'hard', label: 'Hard' }
  ];

  readonly isLoading = signal(true);
  readonly isSaving = signal(false);
  readonly loadError = signal('');
  readonly paths = signal<CrtPath[]>([]);
  readonly modules = signal<CrtModule[]>([]);
  readonly questions = signal<QuestionView[]>([]);
  readonly query = signal('');
  readonly moduleFilter = signal('');
  readonly topicFilter = signal('');
  readonly difficultyFilter = signal<'all' | CrtDifficulty>('all');
  readonly showForm = signal(false);
  readonly editingId = signal<string | null>(null);
  readonly previewId = signal<string | null>(null);
  readonly bulkFile = signal<File | null>(null);
  readonly bulkImporting = signal(false);
  readonly bulkFileError = signal('');
  readonly bulkResults = signal<QuestionImportRowResult[] | null>(null);
  private readonly formHost = viewChild<ElementRef<HTMLElement>>('formHost');
  private readonly previewHost = viewChild<ElementRef<HTMLElement>>('previewHost');

  /** Keeps the current template bindings working until the question HTML is updated. */
  readonly store = {
    questions: () => this.questions(),
    moduleTitle: (moduleId: string) => this.moduleTitle(moduleId)
  };

  readonly form = this.fb.nonNullable.group({
    text: ['', [Validators.required, trimmedMinLength(5)]],
    optionA: ['', Validators.required],
    optionB: ['', Validators.required],
    optionC: ['', Validators.required],
    optionD: ['', Validators.required],
    correct: ['' as CrtAnswer | '', Validators.required],
    moduleId: ['', Validators.required],
    topic: ['', Validators.required],
    difficulty: ['easy' as CrtDifficulty | '', Validators.required],
    explanation: ['']
  });

  readonly moduleChoices = computed(() => this.modules()
    .map((module) => ({
      id: module.id,
      label: `${this.pathTitle(module.path_id)} — ${module.title}`
    }))
    .sort((a, b) => a.label.localeCompare(b.label)));

  readonly preview = computed(() => {
    const id = this.previewId();
    return id ? this.questions().find((question) => question.id === id) : undefined;
  });

  readonly moduleFilterLabel = computed(() => {
    const id = this.moduleFilter();
    if (!id) return '';
    const module = this.modules().find((item) => item.id === id);
    return module ? `${this.pathTitle(module.path_id)} — ${module.title}` : '';
  });

  readonly moduleFilterError = computed(() => {
    const id = this.moduleFilter();
    if (!id || this.isLoading()) return '';
    return this.modules().some((module) => module.id === id)
      ? ''
      : 'That module was not found.';
  });

  readonly importedCount = computed(() => this.bulkResults()?.filter((row) => row.success).length ?? 0);
  readonly skippedCount = computed(() => this.bulkResults()?.filter((row) => row.skipped).length ?? 0);
  readonly failedCount = computed(() => this.bulkResults()?.filter((row) => !row.success && !row.skipped).length ?? 0);

  readonly visibleQuestions = computed(() => {
    const query = this.query().trim().toLowerCase();
    const moduleId = this.moduleFilter();
    const topic = this.topicFilter().trim().toLowerCase();
    const difficulty = this.difficultyFilter();
    return this.questions().filter((question) => {
      if (moduleId && question.moduleId !== moduleId) return false;
      if (topic && !question.topic.toLowerCase().includes(topic)) return false;
      if (difficulty !== 'all' && question.difficulty !== difficulty) return false;
      if (!query) return true;
      const moduleTitle = this.moduleTitle(question.moduleId).toLowerCase();
      return question.text.toLowerCase().includes(query)
        || question.topic.toLowerCase().includes(query)
        || moduleTitle.includes(query);
    });
  });

  ngOnInit(): void {
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      this.moduleFilter.set(params.get('moduleId') ?? '');
    });
    void this.loadQuestions();
  }

  async loadQuestions(options?: { silent?: boolean }): Promise<void> {
    if (!options?.silent) {
      this.isLoading.set(true);
      this.loadError.set('');
    }

    try {
      const [paths, modules, questions] = await Promise.all([
        this.crtService.listPaths(),
        this.crtService.listQuestionModules(),
        this.crtService.listQuestions()
      ]);
      this.paths.set(paths);
      this.modules.set(modules);
      this.questions.set(questions.map((question) => this.toView(question)));
    } catch (error) {
      console.error('Failed to load CRT questions:', error);
      const message = error instanceof Error ? error.message : 'Unable to load questions.';
      if (options?.silent) {
        this.toast.error(message);
      } else {
        this.loadError.set(message);
        this.toast.error(message);
      }
    } finally {
      if (!options?.silent) this.isLoading.set(false);
    }
  }

  onSearch(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  downloadExcelTemplate(): void {
    this.bulkImport.downloadExcelTemplate();
  }

  downloadCsvTemplate(): void {
    this.bulkImport.downloadCsvTemplate();
  }

  onImportFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    this.bulkResults.set(null);
    this.bulkFileError.set('');
    if (!file) {
      this.bulkFile.set(null);
      return;
    }
    const extension = file.name.split('.').pop()?.toLowerCase();
    if (extension !== 'csv' && extension !== 'xlsx') {
      this.bulkFile.set(null);
      this.bulkFileError.set('Choose a .csv or .xlsx file.');
      return;
    }
    this.bulkFile.set(file);
  }

  async importQuestions(): Promise<void> {
    const file = this.bulkFile();
    if (!file || this.bulkImporting()) return;

    this.bulkImporting.set(true);
    this.bulkFileError.set('');
    this.bulkResults.set(null);
    try {
      const results = await this.bulkImport.importFile(file);
      this.bulkResults.set(results);
      const imported = results.filter((row) => row.success).length;
      const failed = results.filter((row) => !row.success && !row.skipped).length;
      if (imported > 0) {
        this.toast.success(`Imported ${imported} question${imported === 1 ? '' : 's'}.`);
        await this.loadQuestions({ silent: true });
      }
      if (failed > 0) {
        this.toast.error(`${failed} row${failed === 1 ? '' : 's'} could not be imported.`);
      }
    } catch (error) {
      this.bulkFileError.set(error instanceof Error ? error.message : 'The import could not be completed.');
    } finally {
      this.bulkImporting.set(false);
    }
  }

  setTopicFilter(topic: string): void {
    this.topicFilter.set(topic);
  }

  setDifficultyFilter(difficulty: 'all' | CrtDifficulty): void {
    this.difficultyFilter.set(difficulty);
  }

  setModuleFilter(moduleId: string): void {
    this.moduleFilter.set(moduleId);
    void this.router.navigate(['/admin/crt/questions'], {
      queryParams: moduleId ? { moduleId } : {}
    });
  }

  clearModuleFilter(): void {
    this.setModuleFilter('');
  }

  openCreate(): void {
    if (this.modules().length === 0) {
      this.toast.error('Add a module before creating a question.');
      return;
    }
    this.previewId.set(null);
    this.editingId.set(null);
    const preferred = this.moduleFilter();
    const moduleId = this.modules().some((module) => module.id === preferred)
      ? preferred
      : this.modules()[0].id;
    this.form.reset({
      text: '',
      optionA: '',
      optionB: '',
      optionC: '',
      optionD: '',
      correct: '',
      moduleId,
      topic: '',
      difficulty: 'easy',
      explanation: ''
    });
    this.revealForm();
  }

  openEdit(id: string): void {
    const question = this.questions().find((item) => item.id === id);
    if (!question) {
      this.toast.error('That question was not found.');
      return;
    }
    this.previewId.set(null);
    this.editingId.set(id);
    this.form.reset({
      text: question.text,
      optionA: question.optionA,
      optionB: question.optionB,
      optionC: question.optionC,
      optionD: question.optionD,
      correct: question.correct,
      moduleId: question.moduleId,
      topic: question.topic,
      difficulty: question.difficulty ?? '',
      explanation: question.explanation
    });
    this.revealForm();
  }

  openPreview(id: string): void {
    if (!this.questions().some((question) => question.id === id)) {
      this.toast.error('That question was not found.');
      return;
    }
    this.showForm.set(false);
    this.editingId.set(null);
    this.previewId.set(id);
    this.revealPreview();
  }

  closeForm(): void {
    this.showForm.set(false);
    this.editingId.set(null);
  }

  closePreview(): void {
    this.previewId.set(null);
  }

  async remove(question: QuestionView): Promise<void> {
    const confirmed = await this.confirmDialog.confirm({
      title: 'Delete question',
      message: 'Delete this question from the question bank?',
      confirmLabel: 'Delete',
      variant: 'danger'
    });
    if (!confirmed) return;

    try {
      await this.crtService.deleteQuestion(question.id);
      if (this.editingId() === question.id) this.closeForm();
      if (this.previewId() === question.id) this.closePreview();
      this.toast.success('Question deleted');
      await this.loadQuestions();
    } catch (error) {
      console.error('Failed to delete CRT question:', error);
      this.toast.error(
        error instanceof Error ? error.message : 'Unable to delete question.'
      );
    }
  }

  async save(): Promise<void> {
    if (this.form.invalid || !this.form.controls.correct.value) {
      this.form.markAllAsTouched();
      this.toast.error('Check the highlighted fields.');
      return;
    }
    if (this.isSaving()) return;

    const raw = this.form.getRawValue();
    if (!this.modules().some((module) => module.id === raw.moduleId)) {
      this.toast.error('Choose a module that still exists.');
      return;
    }
    const correctIndex = this.correctIndex(raw.correct);
    if (correctIndex === null) {
      this.toast.error('Select the correct answer.');
      return;
    }

    const stem = raw.text.trim();
    const topic = raw.topic.trim();
    const difficulty = raw.difficulty;
    if (difficulty !== 'easy' && difficulty !== 'medium' && difficulty !== 'hard') {
      this.form.controls.difficulty.markAsTouched();
      this.toast.error('Select a difficulty.');
      return;
    }
    const input: CrtQuestionInput = {
      stem,
      options: [raw.optionA.trim(), raw.optionB.trim(), raw.optionC.trim(), raw.optionD.trim()],
      correct_index: correctIndex,
      module_id: raw.moduleId,
      topic,
      difficulty,
      explanation: raw.explanation.trim()
    };
    if (input.options.some((option) => option.length === 0) || stem.length < 5 || !topic) {
      this.form.markAllAsTouched();
      this.toast.error('Check the highlighted fields.');
      return;
    }

    this.isSaving.set(true);
    try {
      const editingId = this.editingId();
      if (editingId) {
        await this.crtService.updateQuestion(editingId, input);
        this.toast.success('Question updated');
      } else {
        await this.crtService.createQuestion(input);
        this.toast.success('Question saved');
      }
      this.closeForm();
      await this.loadQuestions();
    } catch (error) {
      console.error('Failed to save CRT question:', error);
      this.toast.error(
        error instanceof Error ? error.message : 'Unable to save question.'
      );
    } finally {
      this.isSaving.set(false);
    }
  }

  moduleTitle(moduleId: string): string {
    return this.modules().find((module) => module.id === moduleId)?.title ?? 'Unknown module';
  }

  private pathTitle(pathId: string): string {
    return this.paths().find((path) => path.id === pathId)?.title ?? 'Unknown path';
  }

  private toView(question: CrtQuestion): QuestionView {
    const [optionA = '', optionB = '', optionC = '', optionD = ''] = question.options;
    return {
      id: question.id,
      moduleId: question.module_id,
      text: question.stem,
      optionA,
      optionB,
      optionC,
      optionD,
      correct: ANSWERS[question.correct_index] ?? 'A',
      topic: question.topic ?? '',
      difficulty: question.difficulty,
      explanation: question.explanation ?? ''
    };
  }

  private correctIndex(answer: CrtAnswer | ''): CrtCorrectIndex | null {
    const index = ANSWERS.indexOf(answer as CrtAnswer);
    if (index < 0 || index > 3) return null;
    return index as CrtCorrectIndex;
  }

  private revealForm(): void {
    this.showForm.set(true);
    const timer = setTimeout(() => {
      this.formHost()?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    this.destroyRef.onDestroy(() => clearTimeout(timer));
  }

  private revealPreview(): void {
    const timer = setTimeout(() => {
      this.previewHost()?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    this.destroyRef.onDestroy(() => clearTimeout(timer));
  }
}
