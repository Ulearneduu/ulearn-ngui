import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { CrtPracticeModule, CrtPracticeService } from '../services/crt-practice.service';

@Component({
  selector: 'app-crt-modules',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './crt-modules.html',
  styles: `
    .crt-modules {
      max-width: 720px;
      margin: 0 auto;
      padding: 48px 24px 72px;
    }
    .page-header a {
      color: var(--purple);
      font-weight: 700;
      text-decoration: none;
    }
    .page-header h1 {
      margin: 16px 0 8px;
      color: var(--navy);
      font-family: 'Poppins', sans-serif;
    }
    .page-header p,
    .status {
      margin: 0;
      color: var(--muted);
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
    .module-list {
      display: grid;
      gap: 16px;
      margin: 32px 0 0;
      padding: 0;
      list-style: none;
    }
    .module-card {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 20px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
    }
    .module-card h2 {
      margin: 0;
      color: var(--navy);
      font-size: 1.15rem;
    }
    .btn-primary {
      flex: none;
      padding: 10px 18px;
      border: none;
      border-radius: 8px;
      background: var(--purple);
      color: #fff;
      font-weight: 700;
      cursor: pointer;
      text-decoration: none;
    }
  `
})
export class CrtModules implements OnInit {
  private readonly practice = inject(CrtPracticeService);
  private readonly route = inject(ActivatedRoute);

  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly modules = signal<CrtPracticeModule[]>([]);
  private pathId = '';

  ngOnInit(): void {
    this.pathId = this.route.snapshot.paramMap.get('pathId') ?? '';
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);

    if (!this.pathId) {
      this.modules.set([]);
      this.loadError.set('This learning path could not be found.');
      this.loading.set(false);
      return;
    }

    try {
      this.modules.set(await this.practice.listModules(this.pathId));
    } catch (error: unknown) {
      this.modules.set([]);
      this.loadError.set(error instanceof Error ? error.message : 'Could not load modules.');
    } finally {
      this.loading.set(false);
    }
  }

  practiceLink(moduleId: string): string[] {
    return ['/crt/paths', this.pathId, 'modules', moduleId, 'practice'];
  }

  mockLink(): string[] {
    return ['/crt/mock', this.pathId];
  }
}
