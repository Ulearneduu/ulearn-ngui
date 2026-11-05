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
import { ConfirmDialogService } from '../../../core/services/confirm-dialog.service';
import { ToastService } from '../../../core/services/toast';
import { CrtShell } from '../crt-shell/crt-shell';
import { CrtAssignment, CrtAssignmentStatus, CrtDemoStore } from '../crt-demo.store';

@Component({
  selector: 'app-crt-assignments',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, CrtShell],
  templateUrl: './crt-assignments.html',
  styleUrl: '../crt-admin.scss'
})
export class CrtAssignments implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly toast = inject(ToastService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly destroyRef = inject(DestroyRef);
  readonly store = inject(CrtDemoStore);

  readonly filters = [
    { id: 'all', label: 'All' },
    { id: 'draft', label: 'Draft' },
    { id: 'active', label: 'Active' }
  ] as const;

  readonly isLoading = signal(true);
  readonly query = signal('');
  readonly statusFilter = signal<'all' | CrtAssignmentStatus>('all');
  readonly showForm = signal(false);
  readonly editingId = signal<string | null>(null);
  readonly viewId = signal<string | null>(null);
  private readonly formHost = viewChild<ElementRef<HTMLElement>>('formHost');

  readonly form = this.fb.nonNullable.group({
    pathId: ['', Validators.required],
    batchId: ['', Validators.required],
    dueDate: ['', Validators.required],
    status: ['active' as CrtAssignmentStatus, Validators.required]
  });

  readonly pathChoices = computed(() => {
    const editing = this.store.assignmentById(this.editingId() ?? '');
    return this.store.paths()
      .filter((path) => path.status === 'published' || path.id === editing?.pathId)
      .sort((a, b) => a.displayOrder - b.displayOrder);
  });

  readonly viewing = computed(() => {
    const id = this.viewId();
    return id ? this.store.assignmentById(id) : undefined;
  });

  readonly visibleAssignments = computed(() => {
    const query = this.query().trim().toLowerCase();
    const status = this.statusFilter();
    return this.store.assignments().filter((assignment) => {
      if (status !== 'all' && assignment.status !== status) return false;
      if (!query) return true;
      const batch = this.store.batchName(assignment.batchId).toLowerCase();
      const path = this.store.pathTitle(assignment.pathId).toLowerCase();
      return batch.includes(query) || path.includes(query);
    });
  });

  ngOnInit(): void {
    const timer = setTimeout(() => this.isLoading.set(false), 280);
    this.destroyRef.onDestroy(() => clearTimeout(timer));
  }

  onSearch(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  setFilter(id: 'all' | CrtAssignmentStatus): void {
    this.statusFilter.set(id);
  }

  formatDate(value: string): string {
    const date = new Date(`${value}T00:00:00`);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    }).format(date);
  }

  openCreate(): void {
    if (this.pathChoices().length === 0) {
      this.toast.error('Publish a learning path before assigning it.');
      return;
    }
    this.viewId.set(null);
    this.editingId.set(null);
    this.form.reset({
      pathId: '',
      batchId: '',
      dueDate: '',
      status: 'active'
    });
    this.revealForm();
  }

  openEdit(id: string): void {
    const assignment = this.store.assignmentById(id);
    if (!assignment) {
      this.toast.error('That assignment is no longer in the demonstration data.');
      return;
    }
    this.viewId.set(null);
    this.editingId.set(id);
    this.form.reset({
      pathId: assignment.pathId,
      batchId: assignment.batchId,
      dueDate: assignment.dueDate,
      status: assignment.status
    });
    this.revealForm();
  }

  openView(id: string): void {
    if (!this.store.assignmentById(id)) {
      this.toast.error('That assignment is no longer in the demonstration data.');
      return;
    }
    this.showForm.set(false);
    this.editingId.set(null);
    this.viewId.set(id);
  }

  closeForm(): void {
    this.showForm.set(false);
    this.editingId.set(null);
  }

  closeView(): void {
    this.viewId.set(null);
  }

  async unassign(assignment: CrtAssignment): Promise<void> {
    const confirmed = await this.confirmDialog.confirm({
      title: 'Unassign path',
      message: `Remove ${this.store.pathTitle(assignment.pathId)} from ${this.store.batchName(assignment.batchId)}?`,
      confirmLabel: 'Unassign',
      variant: 'danger'
    });
    if (!confirmed) return;
    this.store.deleteAssignment(assignment.id);
    if (this.editingId() === assignment.id) this.closeForm();
    if (this.viewId() === assignment.id) this.closeView();
    this.toast.success('Path unassigned');
  }

  save(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.toast.error('Check the highlighted fields.');
      return;
    }
    const raw = this.form.getRawValue();
    const path = this.store.pathById(raw.pathId);
    const editing = this.store.assignmentById(this.editingId() ?? '');
    const pathAllowed = path?.status === 'published' || path?.id === editing?.pathId;
    if (!path || !pathAllowed) {
      this.toast.error('Choose a published learning path.');
      return;
    }
    if (!this.store.batches().some((batch) => batch.id === raw.batchId)) {
      this.toast.error('Choose a batch.');
      return;
    }
    const duplicate = this.store.assignments().some((assignment) =>
      assignment.id !== this.editingId()
      && assignment.batchId === raw.batchId
      && assignment.pathId === raw.pathId
    );
    if (duplicate) {
      this.toast.error('This batch is already assigned to that learning path.');
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    const input = {
      pathId: raw.pathId,
      batchId: raw.batchId,
      assignedDate: editing?.assignedDate ?? today,
      dueDate: raw.dueDate,
      status: raw.status
    };
    const editingId = this.editingId();
    if (editingId) {
      const updated = this.store.updateAssignment(editingId, input);
      if (!updated) {
        this.toast.error('That assignment is no longer in the demonstration data.');
        return;
      }
      this.toast.success('Assignment updated');
    } else {
      this.store.createAssignment(input);
      this.toast.success('Path assigned');
    }
    this.closeForm();
  }

  private revealForm(): void {
    this.showForm.set(true);
    const timer = setTimeout(() => {
      this.formHost()?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    this.destroyRef.onDestroy(() => clearTimeout(timer));
  }
}
