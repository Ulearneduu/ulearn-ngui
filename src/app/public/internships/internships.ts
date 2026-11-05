import {
  Component, ChangeDetectionStrategy, signal,
  computed, inject, OnInit, OnDestroy
} from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { CommonModule } from '@angular/common';
import { Subject, takeUntil } from 'rxjs';
import { InternshipService } from '../../shared/services/internship.service';
import { InternshipApplicationService } from '../../shared/services/internship-application.service';
import { AuthService } from '../../core/services/auth.service';
import { Internship, InternshipType, InternshipMode } from '../../models';
import { InternshipEnrollModal } from '../../shared/components/internship-enroll-modal/internship-enroll-modal';
import { PaymentService } from '../../shared/services/payment.service';

interface FilterState {
  types: InternshipType[];
  modes: InternshipMode[];
  domains: string[];
  ppoOnly: boolean;
  searchQuery: string;
}

@Component({
  selector: 'app-internships',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, InternshipEnrollModal],
  templateUrl: './internships.html',
  styleUrl: './internships.scss'
})
export class Internships implements OnInit, OnDestroy {
  private readonly router             = inject(Router);
  private readonly route              = inject(ActivatedRoute);
  private readonly internshipService  = inject(InternshipService);
  private readonly applicationService = inject(InternshipApplicationService);
  readonly auth                       = inject(AuthService);
  private readonly paymentService     = inject(PaymentService);
  private readonly destroy$           = new Subject<void>();

  readonly allInternships = signal<Internship[]>([]);
  readonly isLoading      = signal(true);
  readonly loadError      = signal<string | null>(null);
  readonly appliedIds     = signal<Set<string>>(new Set());
  readonly showEnrollModal  = signal(false);
  readonly enrollTarget     = signal<Internship | null>(null);

  readonly filters = signal<FilterState>({
    types: [], modes: [], domains: [],
    ppoOnly: false, searchQuery: '',
  });

  readonly filterPanelOpen = signal(true);
  readonly mobilePanelOpen = signal(false);
  readonly sortBy = signal<'stipend_high' | 'stipend_low' | 'duration'>('stipend_high');

  // ── Options ───────────────────────────────────────────────────────────────
  readonly typeOptions = [
    { value: 'short' as InternshipType, label: 'Short Term (1–3 months)', color: 'var(--blue)'   },
    { value: 'long'  as InternshipType, label: 'Long Term (6–12 months)', color: 'var(--purple)' },
  ];

  readonly modeOptions = [
    { value: 'remote' as InternshipMode, label: 'Remote',  color: 'var(--green)'  },
    { value: 'hybrid' as InternshipMode, label: 'Hybrid',  color: 'var(--orange)' },
    { value: 'onsite' as InternshipMode, label: 'On-site', color: 'var(--blue)'   },
  ];

  readonly domainOptions = [
    { value: 'Technical',  color: 'var(--purple)' },
    { value: 'Design',     color: 'var(--orange)' },
    { value: 'Marketing',  color: 'var(--green)'  },
    { value: 'AI/ML',      color: 'var(--blue)'   },
  ];

  readonly sortOptions = [
    { value: 'stipend_high' as const, label: 'Stipend: High–Low' },
    { value: 'stipend_low'  as const, label: 'Stipend: Low–High' },
    { value: 'duration'     as const, label: 'Duration'          },
  ];

  // ── Computed ──────────────────────────────────────────────────────────────
  readonly filteredInternships = computed(() => {
    const f    = this.filters();
    let list   = [...this.allInternships()];

    if (f.searchQuery.trim()) {
      const q = f.searchQuery.toLowerCase();
      list = list.filter(i =>
        i.title.toLowerCase().includes(q) ||
        i.domain.toLowerCase().includes(q) ||
        i.skills.some(s => s.toLowerCase().includes(q))
      );
    }

    if (f.types.length > 0) {
      list = list.filter(i => f.types.includes(i.type));
    }

    if (f.modes.length > 0) {
      list = list.filter(i => f.modes.includes(i.mode));
    }

    if (f.domains.length > 0) {
      list = list.filter(i => f.domains.includes(i.domain));
    }

    if (f.ppoOnly) {
      list = list.filter(i => i.hasPPO);
    }

    const sort = this.sortBy();
    if (sort === 'stipend_high') list.sort((a, b) => b.stipendPerMonth - a.stipendPerMonth);
    if (sort === 'stipend_low')  list.sort((a, b) => a.stipendPerMonth - b.stipendPerMonth);

    return list;
  });

  readonly activeFilterCount = computed(() => {
    const f = this.filters();
    let count = 0;
    if (f.types.length > 0)    count++;
    if (f.modes.length > 0)    count++;
    if (f.domains.length > 0)  count++;
    if (f.ppoOnly)             count++;
    if (f.searchQuery.trim())  count++;
    return count;
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  ngOnInit(): void {
    this.paymentService.unlockPageScroll();
    const applyAfterLogin = this.route.snapshot.queryParamMap.get('apply');

    this.internshipService.loadOpenInternships().subscribe((result) => {
      this.allInternships.set(result.internships);
      this.loadError.set(result.error);
      this.isLoading.set(false);

      if (this.auth.isLoggedIn()) {
        const user = this.auth.currentUser();
        if (user) {
          void this.loadAppliedIds(user.id, applyAfterLogin);
        }
      } else if (applyAfterLogin) {
        const type = this.route.snapshot.params['type'] ?? 'short';
        this.router.navigate(['/auth/login'], {
          queryParams: { returnUrl: `/internships/${type}?apply=${applyAfterLogin}` }
        });
      }
    });

    this.route.params
      .pipe(takeUntil(this.destroy$))
      .subscribe(params => {
        const type = params['type'] as InternshipType | undefined;
        if (type && ['short', 'long'].includes(type)) {
          this.filters.update(f => ({ ...f, types: [type] }));
          this.syncToUrl();
        }
      });

    this.route.queryParams
      .pipe(takeUntil(this.destroy$))
      .subscribe(params => {
        const typeParam   = params['type']   as string | undefined;
        const modeParam   = params['mode']   as string | undefined;
        const domainParam = params['domain'] as string | undefined;
        const ppo         = params['ppo']    === 'true';
        const search      = params['q']      ?? '';
        const sort        = params['sort']   ?? 'stipend_high';

        const validTypes   = ['short', 'long'];
        const validModes   = ['remote', 'hybrid', 'onsite'];
        const validDomains = ['Technical', 'Design', 'Marketing', 'AI/ML'];

        let types   = typeParam   ? typeParam.split(',').filter(t => validTypes.includes(t))   as InternshipType[] : [];
        const modes   = modeParam   ? modeParam.split(',').filter(m => validModes.includes(m))   as InternshipMode[] : [];
        const domains = domainParam ? domainParam.split(',').filter(d => validDomains.includes(d)) : [];

        const routeType = this.route.snapshot.paramMap.get('type');
        if (types.length === 0 && routeType && validTypes.includes(routeType)) {
          types = [routeType as InternshipType];
        }

        this.filters.update(f => ({
          ...f,
          types, modes, domains,
          ppoOnly: ppo,
          searchQuery: search,
        }));

        if (['stipend_high','stipend_low','duration'].includes(sort)) {
          this.sortBy.set(sort as any);
        }
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // ── URL Sync ──────────────────────────────────────────────────────────────
  private syncToUrl(): void {
    const f = this.filters();
    const params: Record<string, string> = {};

    if (f.types.length > 0)    params['type']   = f.types.join(',');
    if (f.modes.length > 0)    params['mode']   = f.modes.join(',');
    if (f.domains.length > 0)  params['domain'] = f.domains.join(',');
    if (f.ppoOnly)             params['ppo']    = 'true';
    if (f.searchQuery.trim())  params['q']      = f.searchQuery.trim();
    if (this.sortBy() !== 'stipend_high') params['sort'] = this.sortBy();

    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: params,
      queryParamsHandling: '',
      replaceUrl: true,
    });
  }

  // ── Filter Actions ────────────────────────────────────────────────────────
  toggleType(val: InternshipType): void {
    this.filters.update(f => {
      const types = f.types.includes(val)
        ? f.types.filter(t => t !== val)
        : [...f.types, val];
      return { ...f, types };
    });
    this.syncToUrl();
  }

  isTypeSelected(val: InternshipType): boolean {
    return this.filters().types.includes(val);
  }

  toggleMode(val: InternshipMode): void {
    this.filters.update(f => {
      const modes = f.modes.includes(val)
        ? f.modes.filter(m => m !== val)
        : [...f.modes, val];
      return { ...f, modes };
    });
    this.syncToUrl();
  }

  isModeSelected(val: InternshipMode): boolean {
    return this.filters().modes.includes(val);
  }

  toggleDomain(val: string): void {
    this.filters.update(f => {
      const domains = f.domains.includes(val)
        ? f.domains.filter(d => d !== val)
        : [...f.domains, val];
      return { ...f, domains };
    });
    this.syncToUrl();
  }

  isDomainSelected(val: string): boolean {
    return this.filters().domains.includes(val);
  }

  togglePPO(): void {
    this.filters.update(f => ({ ...f, ppoOnly: !f.ppoOnly }));
    this.syncToUrl();
  }

  setSearch(val: string): void {
    this.filters.update(f => ({ ...f, searchQuery: val }));
    this.syncToUrl();
  }

  setSortBy(val: 'stipend_high' | 'stipend_low' | 'duration'): void {
    this.sortBy.set(val);
    this.syncToUrl();
  }

  clearAllFilters(): void {
    const routeType = this.route.snapshot.paramMap.get('type');
    const types =
      routeType && ['short', 'long'].includes(routeType)
        ? [routeType as InternshipType]
        : [];
    this.filters.set({
      types,
      modes: [],
      domains: [],
      ppoOnly: false,
      searchQuery: '',
    });
    this.syncToUrl();
  }

  retryLoad(): void {
    this.isLoading.set(true);
    this.loadError.set(null);
    this.internshipService.loadOpenInternships().subscribe((result) => {
      this.allInternships.set(result.internships);
      this.loadError.set(result.error);
      this.isLoading.set(false);
    });
  }

  toggleFilterPanel(): void { this.filterPanelOpen.update(v => !v); }
  toggleMobilePanel(): void { this.mobilePanelOpen.update(v => !v); }

  // ── Helpers ───────────────────────────────────────────────────────────────
  getTypeColor(type: InternshipType): string {
    return type === 'short' ? 'var(--blue)' : 'var(--purple)';
  }

  getTypeLabel(type: InternshipType): string {
    return type === 'short' ? 'Short Term' : 'Long Term';
  }

  getModeColor(mode: InternshipMode): string {
    const map: Record<InternshipMode, string> = {
      remote: 'var(--green)',
      hybrid: 'var(--orange)',
      onsite: 'var(--blue)',
    };
    return map[mode];
  }

  formatStipend(amount: number): string {
    return '₹' + amount.toLocaleString('en-IN') + '/mo';
  }

  formatEnrollmentFee(price: number): string {
    return '₹' + price.toLocaleString('en-IN') + ' enrollment fee';
  }

  hasApplied(internshipId: string): boolean {
    return this.appliedIds().has(internshipId);
  }

  private async loadAppliedIds(userId: string, applyAfterLogin?: string | null): Promise<void> {
    this.applicationService.getUserAppliedInternshipIds(userId).subscribe({
      next: (ids) => {
        this.appliedIds.set(ids);
        if (applyAfterLogin && !ids.has(applyAfterLogin)) {
          this.openEnrollModal(applyAfterLogin);
        }
      }
    });
  }

  enrollReturnUrl(): string {
    const type = this.route.snapshot.params['type'] ?? 'short';
    return `/internships/${type}`;
  }

  openEnrollModal(internshipId: string): void {
    const intern = this.allInternships().find((i) => i.id === internshipId);
    if (!intern || intern.status === 'closed') return;
    if (this.hasApplied(internshipId)) return;

    if (!this.auth.isLoggedIn()) {
      const type = this.route.snapshot.params['type'] ?? 'short';
      this.router.navigate(['/auth/login'], {
        queryParams: { returnUrl: `/internships/${type}?apply=${internshipId}` }
      });
      return;
    }

    this.enrollTarget.set(intern);
    this.showEnrollModal.set(true);
  }

  closeEnrollModal(): void {
    this.showEnrollModal.set(false);
    this.enrollTarget.set(null);
  }

  onEnrolled(internshipId: string): void {
    this.appliedIds.update((set) => new Set([...set, internshipId]));
  }

  handleEnrollClick(internshipId: string): void {
    this.openEnrollModal(internshipId);
  }
}