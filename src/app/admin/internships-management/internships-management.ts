import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  inject,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  FormBuilder,
  FormGroup,
  ReactiveFormsModule,
  Validators
} from '@angular/forms';
import {
  AdminInternshipInput,
  AdminInternshipRow,
  AdminInternshipsService
} from '../services/admin-internships.service';
import { InternshipMode, InternshipType } from '../../models';
import { ToastService } from '../../core/services/toast';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { prepareBlogImage } from '../services/blog-image.util';

@Component({
  selector: 'app-internships-management',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './internships-management.html',
  styleUrl: './internships-management.scss'
})
export class InternshipsManagement implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly internshipsService = inject(AdminInternshipsService);
  private readonly toast = inject(ToastService);
  private readonly confirmDialog = inject(ConfirmDialogService);

  readonly internships = signal<AdminInternshipRow[]>([]);
  readonly isLoading = signal(true);
  readonly isSaving = signal(false);
  readonly isUploadingThumbnail = signal(false);
  readonly showForm = signal(false);
  readonly editingId = signal<string | null>(null);
  readonly thumbnailPreview = signal<string | null>(null);

  form!: FormGroup;
  private pendingThumbnailFile: File | null = null;

  readonly types: InternshipType[] = ['short', 'long'];
  readonly modes: InternshipMode[] = ['remote', 'hybrid', 'onsite'];
  readonly statuses: ('open' | 'closed')[] = ['open', 'closed'];

  ngOnInit(): void {
    this.buildForm();
    void this.loadInternships();
  }

  private buildForm(): void {
    this.form = this.fb.group({
      title: ['', Validators.required],
      type: ['short' as InternshipType, Validators.required],
      mode: ['remote' as InternshipMode, Validators.required],
      domain: ['', Validators.required],
      description: ['', Validators.required],
      durationLabel: ['', Validators.required],
      stipendPerMonth: [0, [Validators.required, Validators.min(0)]],
      price: [0, [Validators.required, Validators.min(0)]],
      originalPrice: [null as number | null],
      hasPpo: [false],
      skillsCsv: [''],
      status: ['open', Validators.required],
      thumbnailUrl: ['']
    });
  }

  private async loadInternships(): Promise<void> {
    this.isLoading.set(true);
    this.internships.set(await this.internshipsService.listAll());
    this.isLoading.set(false);
  }

  openCreate(): void {
    this.editingId.set(null);
    this.pendingThumbnailFile = null;
    this.thumbnailPreview.set(null);
    this.form.reset({
      title: '',
      type: 'short',
      mode: 'remote',
      domain: '',
      description: '',
      durationLabel: '',
      stipendPerMonth: 0,
      price: 0,
      originalPrice: null,
      hasPpo: false,
      skillsCsv: '',
      status: 'open',
      thumbnailUrl: ''
    });
    this.showForm.set(true);
  }

  openEdit(row: AdminInternshipRow): void {
    this.editingId.set(row.id);
    this.pendingThumbnailFile = null;
    this.thumbnailPreview.set(row.thumbnailUrl);
    this.form.reset({
      title: row.title,
      type: row.type,
      mode: row.mode,
      domain: row.domain,
      description: row.description,
      durationLabel: row.durationLabel,
      stipendPerMonth: row.stipendPerMonth,
      price: row.price,
      originalPrice: row.originalPrice,
      hasPpo: row.hasPpo,
      skillsCsv: row.skills.join(', '),
      status: row.status,
      thumbnailUrl: row.thumbnailUrl ?? ''
    });
    this.showForm.set(true);
  }

  closeForm(): void {
    const preview = this.thumbnailPreview();
    if (preview?.startsWith('blob:')) URL.revokeObjectURL(preview);
    this.showForm.set(false);
    this.editingId.set(null);
    this.pendingThumbnailFile = null;
    this.thumbnailPreview.set(null);
  }

  onThumbnailSelected(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    void this.setThumbnailFromFile(file);
    (event.target as HTMLInputElement).value = '';
  }

  private async setThumbnailFromFile(file: File): Promise<void> {
    try {
      const prepared = await prepareBlogImage(file, 800);
      this.pendingThumbnailFile = prepared;
      this.thumbnailPreview.set(URL.createObjectURL(prepared));
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Could not load image');
      this.pendingThumbnailFile = null;
      this.thumbnailPreview.set(this.form.get('thumbnailUrl')?.value || null);
    }
  }

  async save(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const raw = this.form.getRawValue();
    const input: AdminInternshipInput = {
      title: String(raw.title).trim(),
      type: raw.type as InternshipType,
      mode: raw.mode as InternshipMode,
      domain: String(raw.domain).trim(),
      description: String(raw.description).trim(),
      durationLabel: String(raw.durationLabel).trim(),
      stipendPerMonth: Number(raw.stipendPerMonth),
      price: Number(raw.price),
      originalPrice:
        raw.originalPrice != null && raw.originalPrice !== ''
          ? Number(raw.originalPrice)
          : undefined,
      hasPpo: Boolean(raw.hasPpo),
      skills: this.parseCsv(String(raw.skillsCsv ?? '')),
      status: raw.status as 'open' | 'closed',
      thumbnailUrl: String(raw.thumbnailUrl ?? '').trim() || undefined
    };

    this.isSaving.set(true);
    try {
      let id = this.editingId();
      if (id) {
        await this.internshipsService.update(id, input);
        this.toast.success('Internship updated');
      } else {
        const created = await this.internshipsService.create(input);
        if (!created) throw new Error('Could not create internship');
        id = created.id;
        this.toast.success('Internship created');
      }

      if (id && this.pendingThumbnailFile) {
        this.isUploadingThumbnail.set(true);
        const url = await this.internshipsService.uploadThumbnail(id, this.pendingThumbnailFile);
        await this.internshipsService.update(id, { ...input, thumbnailUrl: url });
        this.pendingThumbnailFile = null;
        this.isUploadingThumbnail.set(false);
      }

      this.closeForm();
      await this.loadInternships();
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      this.isSaving.set(false);
      this.isUploadingThumbnail.set(false);
    }
  }

  async deleteRow(row: AdminInternshipRow): Promise<void> {
    if (
      !(await this.confirmDialog.confirm({
        title: 'Delete internship',
        message: `Delete "${row.title}"?`,
        confirmLabel: 'Delete',
        variant: 'danger'
      }))
    ) {
      return;
    }
    const ok = await this.internshipsService.delete(row.id);
    if (ok) {
      this.toast.success('Internship deleted');
      if (this.editingId() === row.id) this.closeForm();
      await this.loadInternships();
    } else {
      this.toast.error('Could not delete');
    }
  }

  formatStipend(amount: number): string {
    return '₹' + amount.toLocaleString('en-IN');
  }

  private parseCsv(value: string): string[] {
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
}
