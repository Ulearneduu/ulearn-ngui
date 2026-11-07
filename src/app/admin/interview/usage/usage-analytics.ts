import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { InterviewUsageFilters, InterviewUsageReport, InterviewUsageRow } from '../../../models';
import { AdminInterviewUsageService } from '../../services/admin-interview-usage.service';
import { InterviewAdminShell } from '../interview-shell/interview-shell';
import { formatElapsed, formatEstimatedCost, formatRate, formatScore, formatTokenCount } from './usage-format';
import { localDayRange, recentLocalDates } from './usage-period';
import { usageCsv } from './usage-csv';

const PAGE_SIZE = 25;
const EXPORT_PAGE_SIZE = 200;
const EXPORT_MAX_ROWS = 20000;

@Component({
  selector: 'app-admin-interview-usage',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, InterviewAdminShell],
  templateUrl: './usage-analytics.html',
  styleUrl: './usage-analytics.scss',
})
export class AdminInterviewUsage implements OnInit {
  private readonly usage = inject(AdminInterviewUsageService);

  readonly loading = signal(true);
  readonly exporting = signal(false);
  readonly error = signal<string | null>(null);
  readonly exportError = signal<string | null>(null);
  readonly filters = signal<InterviewUsageFilters | null>(null);
  readonly report = signal<InterviewUsageReport | null>(null);

  fromDate = '';
  toDate = '';
  college = '';
  batchId = '';
  status = '';
  templateId = '';
  private offset = 0;

  ngOnInit(): void {
    const range = recentLocalDates(new Date(), 30);
    this.fromDate = range.fromDate;
    this.toDate = range.toDate;
    void this.reload(true);
  }

  async apply(): Promise<void> {
    this.offset = 0;
    await this.reload(false);
  }

  async previousPage(): Promise<void> {
    this.offset = Math.max(0, this.offset - PAGE_SIZE);
    await this.reload(false);
  }

  async nextPage(): Promise<void> {
    this.offset += PAGE_SIZE;
    await this.reload(false);
  }

  async exportCsv(): Promise<void> {
    const bounds = localDayRange(this.fromDate, this.toDate);
    if (!bounds) {
      this.exportError.set('Choose a valid date range.');
      return;
    }
    this.exporting.set(true);
    this.exportError.set(null);
    try {
      const rows: InterviewUsageRow[] = [];
      let offset = 0;
      let total = 0;
      do {
        const page = await this.usage.report({
          ...bounds,
          college: this.college || null,
          batchId: this.batchId || null,
          status: this.status || null,
          templateId: this.templateId || null,
          limit: EXPORT_PAGE_SIZE,
          offset,
        });
        total = page.page.total;
        if (total > EXPORT_MAX_ROWS) {
          this.exportError.set('This export is larger than 20,000 sessions. Narrow the date range or filters.');
          return;
        }
        rows.push(...page.rows);
        offset += page.rows.length;
        if (page.rows.length === 0) break;
      } while (offset < total);
      this.download(usageCsv(rows), `interview-usage-${this.fromDate}-to-${this.toDate}.csv`);
    } catch (err) {
      this.exportError.set(err instanceof Error ? err.message : 'Could not export interview usage.');
    } finally {
      this.exporting.set(false);
    }
  }

  costLabel(): string {
    const summary = this.report()?.summary;
    if (!summary) return '—';
    return formatEstimatedCost(summary.estimatedCost, summary.currency, summary.costStatus);
  }

  costLabelFor(row: InterviewUsageRow): string {
    return formatEstimatedCost(row.estimatedCost, row.currency, row.costStatus);
  }

  tokenLabel(value: number | null): string {
    return formatTokenCount(value);
  }

  elapsedLabel(value: number | null): string {
    return formatElapsed(value);
  }

  rateLabel(value: number | null): string {
    return formatRate(value);
  }

  scoreLabel(value: number | null): string {
    return formatScore(value);
  }

  studentLabel(id: string): string {
    return id.slice(0, 8);
  }

  pageStart(): number {
    const report = this.report();
    if (!report || report.page.total === 0) return 0;
    return report.page.offset + 1;
  }

  pageEnd(): number {
    const report = this.report();
    if (!report) return 0;
    return Math.min(report.page.total, report.page.offset + report.rows.length);
  }

  canGoBack(): boolean {
    return (this.report()?.page.offset ?? 0) > 0;
  }

  canGoForward(): boolean {
    const report = this.report();
    if (!report) return false;
    return report.page.offset + report.rows.length < report.page.total;
  }

  private async reload(includeFilters: boolean): Promise<void> {
    const bounds = localDayRange(this.fromDate, this.toDate);
    if (!bounds) {
      this.error.set('Choose a valid date range.');
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    try {
      const reportPromise = this.usage.report({
        ...bounds,
        college: this.college || null,
        batchId: this.batchId || null,
        status: this.status || null,
        templateId: this.templateId || null,
        limit: PAGE_SIZE,
        offset: this.offset,
      });
      if (includeFilters) {
        const [filters, report] = await Promise.all([this.usage.filters(), reportPromise]);
        this.filters.set(filters);
        this.report.set(report);
      } else {
        this.report.set(await reportPromise);
      }
    } catch (err) {
      this.report.set(null);
      this.error.set(err instanceof Error ? err.message : 'Could not load interview usage analytics.');
    } finally {
      this.loading.set(false);
    }
  }

  private download(contents: string, filename: string): void {
    const blob = new Blob([contents], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }
}
