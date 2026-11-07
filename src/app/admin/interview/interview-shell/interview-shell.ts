import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

@Component({
  selector: 'app-interview-admin-shell',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './interview-shell.html',
  styleUrl: '../../crt/crt-admin.scss',
})
export class InterviewAdminShell {
  readonly crumb = input.required<string>();
}
