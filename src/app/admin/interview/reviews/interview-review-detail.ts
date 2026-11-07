import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  formatCompletedAt,
  formatScore,
  interviewKindLabel,
} from '../../../interview/interview-evaluation';
import {
  isValidInterviewScore,
  isValidOverrideReason,
} from '../../../interview/interview-score-overrides';
import type { InterviewOverrideTargetKind, InterviewReviewDetail } from '../../../models';
import { AdminInterviewReviewsService } from '../../services/admin-interview-reviews.service';
import { InterviewAdminShell } from '../interview-shell/interview-shell';

@Component({
  selector: 'app-admin-interview-review-detail',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, InterviewAdminShell],
  templateUrl: './interview-review-detail.html',
  styleUrl: './interview-review-detail.scss',
})
export class AdminInterviewReviewDetail implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly reviews = inject(AdminInterviewReviewsService);

  readonly loading = signal(true);
  readonly working = signal(false);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly detail = signal<InterviewReviewDetail | null>(null);

  readonly overallScore = signal('');
  readonly overallReason = signal('');
  readonly competencyName = signal('');
  readonly competencyScore = signal('');
  readonly competencyReason = signal('');

  readonly competencyOptions = computed(() =>
    (this.detail()?.effectiveCompetencies ?? []).map((row) => row.competency)
  );

  ngOnInit(): void {
    void this.reload();
  }

  async reload(): Promise<void> {
    const sessionId = this.route.snapshot.paramMap.get('sessionId')?.trim() ?? '';
    if (!sessionId) {
      this.error.set('Interview session is missing.');
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    try {
      const detail = await this.reviews.getDetail(sessionId);
      this.detail.set(detail);
      if (!this.competencyName() && detail.effectiveCompetencies[0]) {
        this.competencyName.set(detail.effectiveCompetencies[0].competency);
      }
    } catch (err) {
      this.detail.set(null);
      this.error.set(err instanceof Error ? err.message : 'Could not load this review.');
    } finally {
      this.loading.set(false);
    }
  }

  kindLabel(kind: string | null): string {
    return kind ? interviewKindLabel(kind) : 'Interview';
  }

  scoreText(score: number | null): string {
    return score === null ? '—' : formatScore(score);
  }

  when(value: string | null): string {
    return formatCompletedAt(value) ?? '—';
  }

  targetLabel(kind: InterviewOverrideTargetKind, competency: string | null): string {
    return kind === 'overall' ? 'Overall' : `Competency: ${competency ?? '—'}`;
  }

  async submitOverall(): Promise<void> {
    await this.submitOverride('overall', null, this.overallScore(), this.overallReason());
  }

  async submitCompetency(): Promise<void> {
    await this.submitOverride(
      'competency',
      this.competencyName().trim(),
      this.competencyScore(),
      this.competencyReason()
    );
  }

  async togglePublish(): Promise<void> {
    const current = this.detail();
    if (!current) return;
    this.working.set(true);
    this.error.set(null);
    this.notice.set(null);
    try {
      await this.reviews.setPublished(current.sessionId, !current.mentorReviewPublished);
      this.notice.set(
        !current.mentorReviewPublished
          ? 'Mentor-adjusted scores are now visible to the student.'
          : 'Mentor-adjusted scores are hidden from the student again.'
      );
      await this.reload();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Could not update publish state.');
    } finally {
      this.working.set(false);
    }
  }

  private async submitOverride(
    targetKind: InterviewOverrideTargetKind,
    competency: string | null,
    scoreRaw: string,
    reasonRaw: string
  ): Promise<void> {
    const current = this.detail();
    if (!current) return;

    const score = Number(scoreRaw);
    const reason = reasonRaw.trim();
    if (!isValidInterviewScore(score)) {
      this.error.set('Score must be a number between 0 and 100.');
      return;
    }
    if (!isValidOverrideReason(reason)) {
      this.error.set('A reason of at least 10 characters is required.');
      return;
    }
    if (targetKind === 'competency' && !competency) {
      this.error.set('Choose a competency to override.');
      return;
    }

    const effective =
      targetKind === 'overall'
        ? current.effectiveOverallScore
        : current.effectiveCompetencies.find((row) => row.competency === competency)?.effectiveScore ??
          null;
    if (effective !== null && Math.round(score * 100) / 100 === effective) {
      this.error.set('The new score must differ from the current effective score.');
      return;
    }

    this.working.set(true);
    this.error.set(null);
    this.notice.set(null);
    try {
      await this.reviews.applyOverride({
        sessionId: current.sessionId,
        targetKind,
        competency,
        newScore: Math.round(score * 100) / 100,
        reason,
      });
      if (targetKind === 'overall') {
        this.overallScore.set('');
        this.overallReason.set('');
      } else {
        this.competencyScore.set('');
        this.competencyReason.set('');
      }
      this.notice.set('Override saved. AI scores were not changed.');
      await this.reload();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Could not save the override.');
    } finally {
      this.working.set(false);
    }
  }
}
