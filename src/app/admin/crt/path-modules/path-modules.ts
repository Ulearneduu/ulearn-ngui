
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
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ToastService } from '../../../core/services/toast';
import { CrtShell } from '../crt-shell/crt-shell';
import {
  CrtAdminService,
  CrtPath,
  CrtModule
} from '../../services/crt-admin.service';

@Component({
  selector: 'app-crt-path-modules',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, CrtShell],
  templateUrl: './path-modules.html',
  styleUrl: '../crt-admin.scss'
})
export class CrtPathModules implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly crtService = inject(CrtAdminService);

  readonly isLoading = signal(true);
  readonly isSaving = signal(false);
  readonly pathId = signal('');
  readonly path = signal<CrtPath | null>(null);
  readonly modules = signal<CrtModule[]>([]);
  readonly query = signal('');
  readonly showForm = signal(false);
  readonly editingId = signal<string | null>(null);

  private readonly formHost = viewChild<ElementRef<HTMLElement>>('formHost');

  readonly form = this.fb.nonNullable.group({
    title: ['', [Validators.required, Validators.minLength(2)]],
    displayOrder: [1, [Validators.required, Validators.min(1)]]
  });

  readonly pathModules = computed(() =>
    [...this.modules()].sort(
      (a, b) => a.sort_order - b.sort_order
    )
  );

  readonly visibleModules = computed(() => {
    const query = this.query().trim().toLowerCase();

    return this.pathModules().filter(module =>
      module.title.toLowerCase().includes(query)
    );
  });

  ngOnInit(): void {
    this.route.paramMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(params => {
        const id = params.get('pathId') ?? '';
        this.pathId.set(id);
        this.closeForm();

        if (id) {
          void this.loadData(id);
        } else {
          this.path.set(null);
          this.modules.set([]);
          this.isLoading.set(false);
        }
      });
  }

  async loadData(pathId: string): Promise<void> {
    this.isLoading.set(true);

    try {
      const [paths, modules] = await Promise.all([
        this.crtService.listPaths(),
        this.crtService.listModules(pathId)
      ]);

      this.path.set(paths.find(item => item.id === pathId) ?? null);
      this.modules.set(modules);
    } catch (error) {
      console.error('Failed to load CRT modules:', error);
      this.toast.error(
        error instanceof Error ? error.message : 'Unable to load modules.'
      );
    } finally {
      this.isLoading.set(false);
    }
  }

  onSearch(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  isFirst(moduleId: string): boolean {
    return this.pathModules()[0]?.id === moduleId;
  }

  isLast(moduleId: string): boolean {
    const modules = this.pathModules();
    return modules[modules.length - 1]?.id === moduleId;
  }

  openCreate(): void {
    if (!this.path()) {
      this.toast.error('Learning path not found.');
      return;
    }

    this.editingId.set(null);
    this.form.reset({
      title: '',
      displayOrder: this.pathModules().length + 1
    });

    this.revealForm();
  }

  openEdit(id: string): void {
    const module = this.modules().find(item => item.id === id);

    if (!module) {
      this.toast.error('Module not found.');
      return;
    }

    this.editingId.set(id);
    this.form.reset({
      title: module.title,
      displayOrder: module.sort_order + 1
    });

    this.revealForm();
  }

  closeForm(): void {
    this.showForm.set(false);
    this.editingId.set(null);
  }

  async move(moduleId: string, direction: -1 | 1): Promise<void> {
    const ordered = this.pathModules();
    const currentIndex = ordered.findIndex(item => item.id === moduleId);
    const targetIndex = currentIndex + direction;

    if (
      currentIndex < 0 ||
      targetIndex < 0 ||
      targetIndex >= ordered.length
    ) {
      return;
    }

    const reordered = [...ordered];
    [reordered[currentIndex], reordered[targetIndex]] = [
      reordered[targetIndex],
      reordered[currentIndex]
    ];

    const updates = reordered.map((module, index) => ({
      id: module.id,
      sort_order: index
    }));

    try {
      await this.crtService.reorderModules(updates);
      await this.loadData(this.pathId());
      this.toast.success('Module order updated.');
    } catch (error) {
      console.error('Failed to reorder modules:', error);
      this.toast.error(
        error instanceof Error ? error.message : 'Unable to reorder modules.'
      );
    }
  }

  async save(): Promise<void> {
    const pathId = this.pathId();

    if (!this.path()) {
      this.toast.error('This learning path was not found.');
      return;
    }

    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.toast.error('Check the highlighted fields.');
      return;
    }

    if (this.isSaving()) return;

    const raw = this.form.getRawValue();
    const displayOrder = Number(raw.displayOrder);

    if (!Number.isInteger(displayOrder) || displayOrder < 1) {
      this.toast.error('Display order must be a whole number of at least 1.');
      return;
    }

    const editingId = this.editingId();

    if (displayOrder > this.pathModules().length + (editingId ? 0 : 1)) {
      this.toast.error('Display order is outside the available range.');
      return;
    }

    this.isSaving.set(true);

    try {
      if (editingId) {
        await this.crtService.updateModule(editingId, {
          title: raw.title.trim(),
          sort_order: displayOrder - 1
        });
        this.toast.success('Module updated successfully.');
      } else {
        await this.crtService.createModule(
          pathId,
          raw.title.trim(),
          displayOrder - 1
        );
        this.toast.success('Module created successfully.');
      }

      this.closeForm();
      await this.loadData(pathId);
    } catch (error) {
      console.error('Failed to save module:', error);
      this.toast.error(
        error instanceof Error ? error.message : 'Unable to save module.'
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
