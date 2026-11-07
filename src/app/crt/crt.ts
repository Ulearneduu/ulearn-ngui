
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  CrtPracticePath,
  CrtPracticeModule,
  CrtPracticeService
} from './services/crt-practice.service';
import { CrtReadinessScore, CrtReadinessService } from './services/crt-readiness.service';

interface CrtPathProgress {
  path: CrtPracticePath;
  modules: CrtPracticeModule[];
  attemptedModules: number;
  progress: number;
  continueModule: CrtPracticeModule | null;
  readiness: CrtReadinessScore;
}

@Component({
  selector: 'app-crt',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './crt.html',
  styles: `
    .crt-home {
      max-width: 900px;
      margin: 0 auto;
      padding: 48px 24px 72px;
    }

    .page-header a {
      color: var(--purple);
      font-weight: 700;
      text-decoration: none;
    }

    .page-header h1 {
      margin: 0 0 8px;
      color: var(--navy);
      font-family: 'Poppins', sans-serif;
    }

    .page-header p,
    .path-card p,
    .status,
    .assignment-note {
      margin: 0;
      color: var(--muted);
    }

    .assignment-note {
      margin-top: 12px;
      font-size: 0.875rem;
    }

    .status,
    .banner {
      margin-top: 32px;
    }

    .banner {
      padding: 16px;
      border: 1px solid #f3c2c2;
      border-radius: 12px;
      background: #fdecec;
    }

    .banner p {
      margin-bottom: 12px;
      color: var(--navy);
    }

    .path-list {
      display: grid;
      gap: 16px;
      margin: 32px 0 0;
      padding: 0;
      list-style: none;
    }

    .path-card {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 12px;
      padding: 24px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
    }

    .path-card h2 {
      margin: 0;
      color: var(--navy);
      font-size: 1.2rem;
    }

    .path-heading {
      width: 100%;
      display: flex;
      flex-wrap: wrap;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px 16px;
    }

    .path-heading h2 {
      flex: 1 1 220px;
    }

    .readiness {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 4px;
      min-width: 96px;
      padding: 10px 14px;
      border-radius: 12px;
      background: color-mix(in srgb, var(--purple) 14%, var(--card));
    }

    .readiness-value {
      color: var(--navy);
      font-family: 'Poppins', sans-serif;
      font-size: 1.6rem;
      font-weight: 800;
      line-height: 1;
    }

    .readiness-label {
      color: var(--muted);
      font-size: 0.75rem;
      font-weight: 700;
    }

    @media (max-width: 640px) {
      .crt-home {
        padding: 32px 16px 56px;
      }

      .readiness {
        align-items: flex-start;
      }
    }

    .progress-info {
      width: 100%;
      display: flex;
      justify-content: space-between;
      gap: 12px;
      color: var(--muted);
      font-size: 0.875rem;
    }

    .progress-track {
      width: 100%;
      height: 9px;
      overflow: hidden;
      border-radius: 99px;
      background: var(--border);
    }

    .progress-fill {
      height: 100%;
      border-radius: inherit;
      background: var(--purple);
      transition: width 0.2s ease;
    }

    .btn-primary {
      margin-top: 8px;
      padding: 10px 20px;
      border: none;
      border-radius: 8px;
      background: var(--purple);
      color: #fff;
      font-weight: 700;
      cursor: pointer;
    }

    .btn-primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  `
})
export class Crt implements OnInit {
  private readonly practice = inject(CrtPracticeService);
  private readonly readiness = inject(CrtReadinessService);
  private readonly router = inject(Router);

  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly paths = signal<CrtPathProgress[]>([]);

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);

    try {
      const [publishedPaths, attempts] = await Promise.all([
        this.practice.listPublishedPaths(),
        this.practice.listMyPracticeAttempts()
      ]);

      const progressItems = await Promise.all(
        publishedPaths.map(async (path): Promise<CrtPathProgress> => {
          const [modules, readiness] = await Promise.all([
            this.practice.listModules(path.id),
            this.readiness.getPathReadiness(path.id)
          ]);

          const pathAttempts = attempts.filter(
            (attempt) =>
              attempt.path_id === path.id &&
              attempt.module_id !== null
          );

          const moduleIds = new Set(
            modules.map((module) => module.id)
          );

          const attemptedModuleIds = new Set(
            pathAttempts
              .map((attempt) => attempt.module_id)
              .filter(
                (moduleId): moduleId is string =>
                  moduleId !== null && moduleIds.has(moduleId)
              )
          );

          const attemptedModules = attemptedModuleIds.size;

          const progress = modules.length > 0
            ? Math.round((attemptedModules / modules.length) * 100)
            : 0;

          const inProgressAttempt = pathAttempts.find(
            (attempt) =>
              attempt.status === 'in_progress' &&
              modules.some((module) => module.id === attempt.module_id)
          );

          const nextModule = modules.find(
            (module) => !attemptedModuleIds.has(module.id)
          );

          const continueModule = inProgressAttempt
            ? modules.find(
                (module) => module.id === inProgressAttempt.module_id
              ) ?? null
            : nextModule ?? modules[modules.length - 1] ?? null;

          return {
            path,
            modules,
            attemptedModules,
            progress,
            continueModule,
            readiness
          };
        })
      );

      this.paths.set(progressItems);
    } catch (error: unknown) {
      this.paths.set([]);
      this.loadError.set(
        error instanceof Error
          ? error.message
          : 'Could not load learning paths.'
      );
    } finally {
      this.loading.set(false);
    }
  }

  continuePath(item: CrtPathProgress): void {
    if (!item.continueModule) return;

    void this.router.navigate([
      '/crt/paths',
      item.path.id,
      'modules',
      item.continueModule.id,
      'practice'
    ]);
  }
}
