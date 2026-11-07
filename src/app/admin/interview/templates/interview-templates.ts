import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import {
  AbstractControl,
  FormBuilder,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import { ToastService } from '../../../core/services/toast';
import {
  DEFAULT_INTERVIEW_CODING_LANGUAGE,
  INTERVIEW_CODING_LANGUAGES,
  InterviewCodingLanguageId,
  InterviewCodingProblem,
  emptyInterviewCodingProblem,
  normalizeInterviewCodingLanguage,
} from '../../../interview/interview-coding';
import {
  AdminInterviewTemplatesService,
  InterviewTemplateAdminKind,
  InterviewTemplateAdminRow,
  InterviewTemplateAdminStatus,
  interviewTemplateVersionLabel,
} from '../../services/admin-interview-templates.service';
import { InterviewAdminShell } from '../interview-shell/interview-shell';

const KIND_OPTIONS: readonly { value: InterviewTemplateAdminKind; label: string }[] = [
  { value: 'hr', label: 'HR' },
  { value: 'technical', label: 'Technical' },
  { value: 'domain', label: 'Domain' },
];

function trimmedMinLength(min: number) {
  return (control: AbstractControl): ValidationErrors | null => {
    const value = String(control.value ?? '').trim();
    return value.length >= min ? null : { minlength: { requiredLength: min, actualLength: value.length } };
  };
}

function slugPattern(control: AbstractControl): ValidationErrors | null {
  const value = String(control.value ?? '').trim();
  if (!value) return { required: true };
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) ? null : { slug: true };
}

function positiveInteger(control: AbstractControl): ValidationErrors | null {
  const raw = control.value;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(value) || value <= 0) return { positiveInteger: true };
  return null;
}

function rubricJsonObject(control: AbstractControl): ValidationErrors | null {
  const text = String(control.value ?? '').trim();
  if (!text) return { required: true };
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { rubricObject: true };
    }
    return null;
  } catch {
    return { rubricJson: true };
  }
}

function publicTestsJson(control: AbstractControl): ValidationErrors | null {
  const text = String(control.value ?? '').trim();
  if (!text) return { required: true };
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return { testsArray: true };
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        return { testsShape: true };
      }
      const row = item as Record<string, unknown>;
      if (typeof row['input'] !== 'string' || typeof row['expectedOutput'] !== 'string') {
        return { testsShape: true };
      }
    }
    return null;
  } catch {
    return { testsJson: true };
  }
}

@Component({
  selector: 'app-admin-interview-templates',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, InterviewAdminShell],
  templateUrl: './interview-templates.html',
  styleUrls: ['../../crt/crt-admin.scss', './interview-templates.scss'],
})
export class AdminInterviewTemplates implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly templatesService = inject(AdminInterviewTemplatesService);

  readonly kindOptions = KIND_OPTIONS;
  readonly codingLanguages = INTERVIEW_CODING_LANGUAGES;
  readonly versionLabel = interviewTemplateVersionLabel;

  readonly templates = signal<InterviewTemplateAdminRow[]>([]);
  readonly filters = [
    { id: 'all', label: 'All' },
    { id: 'draft', label: 'Draft' },
    { id: 'published', label: 'Published' },
  ] as const;

  readonly isLoading = signal(true);
  readonly isSaving = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly query = signal('');
  readonly statusFilter = signal<'all' | InterviewTemplateAdminStatus>('all');
  readonly showForm = signal(false);
  readonly editingId = signal<string | null>(null);

  private readonly formHost = viewChild<ElementRef<HTMLElement>>('formHost');

  readonly form = this.fb.nonNullable.group({
    slug: ['', [slugPattern]],
    title: ['', [Validators.required, trimmedMinLength(2)]],
    kind: ['hr' as InterviewTemplateAdminKind, Validators.required],
    duration_minutes: [20, [Validators.required, positiveInteger]],
    status: ['draft' as InterviewTemplateAdminStatus, Validators.required],
    system_prompt: ['', [Validators.required, trimmedMinLength(20)]],
    rubric_json: ['{}', [Validators.required, rubricJsonObject]],
    coding_enabled: [false],
    coding_title: ['Coding challenge'],
    coding_prompt: [''],
    coding_starter: [''],
    coding_language: [DEFAULT_INTERVIEW_CODING_LANGUAGE as InterviewCodingLanguageId],
    coding_tests_json: ['[]', [publicTestsJson]],
  });

  readonly visibleTemplates = computed(() => {
    const query = this.query().trim().toLowerCase();
    const status = this.statusFilter();
    return this.templates()
      .filter((row) => status === 'all' || row.status === status)
      .filter((row) => {
        if (!query) return true;
        return (
          row.title.toLowerCase().includes(query) ||
          row.slug.toLowerCase().includes(query) ||
          row.kind.toLowerCase().includes(query)
        );
      });
  });

  readonly isCreateMode = computed(() => this.editingId() === null);
  readonly showCodingFields = computed(() => this.form.controls.kind.value === 'technical');

  ngOnInit(): void {
    void this.loadTemplates();
  }

  async loadTemplates(): Promise<void> {
    this.isLoading.set(true);
    this.loadError.set(null);
    try {
      this.templates.set(await this.templatesService.listTemplates());
      this.loadError.set(null);
    } catch (error) {
      console.error('Failed to load interview templates:', error);
      const message =
        error instanceof Error ? error.message : 'Unable to load interview templates.';
      this.loadError.set(message);
      this.toast.error(message);
    } finally {
      this.isLoading.set(false);
    }
  }

  onSearch(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  setFilter(id: 'all' | InterviewTemplateAdminStatus): void {
    this.statusFilter.set(id);
  }

  openCreate(): void {
    this.editingId.set(null);
    this.resetForm(null);
    this.form.controls.slug.enable();
    this.revealForm();
  }

  openEdit(id: string): void {
    const row = this.templates().find((item) => item.id === id);
    if (!row) {
      this.toast.error('Interview template not found.');
      return;
    }
    this.editingId.set(id);
    this.resetForm(row);
    this.form.controls.slug.disable();
    this.revealForm();
  }

  closeForm(): void {
    this.showForm.set(false);
    this.editingId.set(null);
    this.form.controls.slug.enable();
  }

  async save(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.toast.error('Check the highlighted fields.');
      return;
    }
    if (this.isSaving()) return;

    const raw = this.form.getRawValue();
    let rubric: Record<string, unknown>;
    try {
      rubric = JSON.parse(raw.rubric_json.trim()) as Record<string, unknown>;
    } catch {
      this.toast.error('Rubric JSON must be a valid JSON object.');
      return;
    }

    let coding: InterviewCodingProblem | null = null;
    if (raw.kind === 'technical') {
      let tests: { input: string; expectedOutput: string }[] = [];
      try {
        tests = JSON.parse(raw.coding_tests_json.trim()) as {
          input: string;
          expectedOutput: string;
        }[];
      } catch {
        this.toast.error('Public test cases must be valid JSON.');
        return;
      }
      if (raw.coding_enabled && !raw.coding_prompt.trim()) {
        this.toast.error('Enter a coding problem prompt, or disable the coding step.');
        return;
      }
      coding = {
        enabled: raw.coding_enabled,
        title: raw.coding_title.trim() || 'Coding challenge',
        prompt: raw.coding_prompt.trim(),
        starterCode: raw.coding_starter,
        language: normalizeInterviewCodingLanguage(raw.coding_language),
        publicTestCases: tests,
      };
    }

    const input = {
      title: raw.title.trim(),
      kind: raw.kind,
      duration_minutes: Number(raw.duration_minutes),
      status: raw.status,
      system_prompt: raw.system_prompt.trim(),
      rubric_json: rubric,
      coding,
    };

    this.isSaving.set(true);
    try {
      const editingId = this.editingId();
      if (editingId) {
        await this.templatesService.updateTemplate(editingId, input);
        this.toast.success('Interview template updated.');
      } else {
        await this.templatesService.createTemplate({
          ...input,
          slug: raw.slug.trim(),
        });
        this.toast.success('Interview template created.');
      }
      this.closeForm();
      await this.loadTemplates();
    } catch (error) {
      console.error('Failed to save interview template:', error);
      this.toast.error(error instanceof Error ? error.message : 'Unable to save interview template.');
    } finally {
      this.isSaving.set(false);
    }
  }

  private resetForm(row: InterviewTemplateAdminRow | null): void {
    const coding = row?.coding ?? emptyInterviewCodingProblem();
    this.form.reset({
      slug: row?.slug ?? '',
      title: row?.title ?? '',
      kind: row?.kind ?? 'hr',
      duration_minutes: row?.duration_minutes ?? 20,
      status: row?.status ?? 'draft',
      system_prompt: row?.system_prompt ?? '',
      rubric_json: row ? JSON.stringify(row.rubric_json, null, 2) : '{}',
      coding_enabled: coding.enabled,
      coding_title: coding.title,
      coding_prompt: coding.prompt,
      coding_starter: coding.starterCode,
      coding_language: coding.language,
      coding_tests_json: JSON.stringify(coding.publicTestCases, null, 2),
    });
  }

  private revealForm(): void {
    this.showForm.set(true);
    const timer = setTimeout(() => {
      this.formHost()?.nativeElement.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    });
    this.destroyRef.onDestroy(() => clearTimeout(timer));
  }
}
