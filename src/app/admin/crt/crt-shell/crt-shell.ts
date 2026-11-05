import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { CrtDemoStore } from '../crt-demo.store';

@Component({
  selector: 'app-crt-shell',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './crt-shell.html',
  styleUrl: '../crt-admin.scss'
})
export class CrtShell {
  readonly crumb = input.required<string>();

  private readonly store = inject(CrtDemoStore);

  readonly modulesLink = computed(() => {
    const pathId = this.store.selectedPathId();
    const exists = this.store.paths().some((path) => path.id === pathId);
    return exists ? ['/admin/crt/paths', pathId, 'modules'] : ['/admin/crt/paths'];
  });
}
