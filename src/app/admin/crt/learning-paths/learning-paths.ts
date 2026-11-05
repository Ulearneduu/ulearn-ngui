
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
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ToastService } from '../../../core/services/toast';
import { CrtShell } from '../crt-shell/crt-shell';
import { CrtAdminService, CrtPath } from '../../services/crt-admin.service';

type CrtContentStatus = 'draft' | 'published';

@Component({
  selector: 'app-crt-learning-paths',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, CrtShell],
  templateUrl: './learning-paths.html',
  styleUrl: '../crt-admin.scss'
})
export class CrtLearningPaths implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly crtService = inject(CrtAdminService);

  readonly paths = signal<CrtPath[]>([]);
  readonly moduleCounts = signal<Record<string, number>>({});

  readonly filters = [
    { id: 'all', label: 'All' },
    { id: 'draft', label: 'Draft' },
    { id: 'published', label: 'Published' }
  ] as const;

  readonly isLoading = signal(true);
  readonly isSaving = signal(false);
  readonly query = signal('');
  readonly statusFilter = signal<'all' | CrtContentStatus>('all');
  readonly showForm = signal(false);
  readonly editingId = signal<string | null>(null);

  private readonly formHost = viewChild<ElementRef<HTMLElement>>('formHost');

  readonly form = this.fb.nonNullable.group({
    title: ['', [Validators.required, Validators.minLength(2)]],
    description: [''],
    status: ['draft' as CrtContentStatus, Validators.required]
  });

  readonly visiblePaths = computed(() => {
    const query = this.query().trim().toLowerCase();
    const status = this.statusFilter();

    return this.paths()
      .filter(path => status === 'all' || path.status === status)
      .filter(path => {
        if (!query) return true;

        return path.title.toLowerCase().includes(query)
          || (path.description ?? '').toLowerCase().includes(query);
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  });

  ngOnInit(): void {
    void this.loadPaths();
  }

  async loadPaths(): Promise<void> {
    this.isLoading.set(true);

    try {
      const paths = await this.crtService.listPaths();
      this.paths.set(paths);

      const counts: Record<string, number> = {};

      await Promise.all(
        paths.map(async path => {
          const modules = await this.crtService.listModules(path.id);
          counts[path.id] = modules.length;
        })
      );

      this.moduleCounts.set(counts);
    } catch (error) {
      console.error('Failed to load CRT learning paths:', error);
      this.toast.error(
        error instanceof Error ? error.message : 'Unable to load learning paths.'
      );
    } finally {
      this.isLoading.set(false);
    }
  }

  moduleCount(pathId: string): number {
    return this.moduleCounts()[pathId] ?? 0;
  }

  onSearch(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  setFilter(id: 'all' | CrtContentStatus): void {
    this.statusFilter.set(id);
  }

  openCreate(): void {
    this.editingId.set(null);

    this.form.reset({
      title: '',
      description: '',
      status: 'draft'
    });

    this.revealForm();
  }

  openEdit(id: string): void {
    const path = this.paths().find(item => item.id === id);

    if (!path) {
      this.toast.error('Learning path not found.');
      return;
    }

    this.editingId.set(id);

    this.form.reset({
      title: path.title,
      description: path.description ?? '',
      status: path.status
    });

    this.revealForm();
  }

  closeForm(): void {
    this.showForm.set(false);
    this.editingId.set(null);
  }

  async save(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.toast.error('Check the highlighted fields.');
      return;
    }

    if (this.isSaving()) return;

    const raw = this.form.getRawValue();

    const input = {
      title: raw.title.trim(),
      description: raw.description.trim(),
      status: raw.status
    };

    this.isSaving.set(true);

    try {
      const editingId = this.editingId();

      if (editingId) {
        await this.crtService.updatePath(editingId, input);
        this.toast.success('Learning path updated successfully.');
      } else {
        await this.crtService.createPath(input);
        this.toast.success('Learning path created successfully.');
      }

      this.closeForm();
      await this.loadPaths();
    } catch (error) {
      console.error('Failed to save CRT learning path:', error);
      this.toast.error(
        error instanceof Error ? error.message : 'Unable to save learning path.'
      );
    } finally {
      this.isSaving.set(false);
    }
  }

  private revealForm(): void {
    this.showForm.set(true);

    const timer = setTimeout(() => {
      this.formHost()?.nativeElement.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest'
      });
    });

    this.destroyRef.onDestroy(() => clearTimeout(timer));
  }
}
