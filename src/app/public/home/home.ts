import {
  Component, ChangeDetectionStrategy, signal,
  inject, OnInit, OnDestroy
} from '@angular/core';
import { Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { CourseService } from '../../shared/services/course.service';
import { PaperService } from '../../shared/services/paper.service';
import { InternshipService } from '../../shared/services/internship.service';
import { BlogService } from '../../shared/services/blog.service';
import { StudentStoryService } from '../../shared/services/student-story.service';
import { SiteSettingsService } from '../../shared/services/site-settings.service';
import { CourseListItem, ResearchPaper, Internship, BlogListItem, StudentStory } from '../../models';
import {
  LEARNER_COLLEGES_ROW1,
  LEARNER_COLLEGES_ROW2,
  PARTNERED_COLLEGES
} from '../../shared/constants/college-partners.data';
import { resolvePublicImageUrl, DEFAULT_HOME_HERO_IMAGE } from '../../shared/utils/drive-image.util';

@Component({
  selector: 'app-home',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  templateUrl: './home.html',
  styleUrl: './home.scss'
})
export class Home implements OnInit, OnDestroy {
  private readonly router             = inject(Router);
  private readonly courseService      = inject(CourseService);
  private readonly paperService       = inject(PaperService);
  private readonly internshipService  = inject(InternshipService);
  private readonly blogService        = inject(BlogService);
  private readonly studentStoryService = inject(StudentStoryService);
  private readonly siteSettingsService = inject(SiteSettingsService);
  private readonly destroy$           = new Subject<void>();

  // ── Data ──────────────────────────────────────────────────────────────────
  readonly featuredCourses      = signal<CourseListItem[]>([]);
  readonly featuredPapers       = signal<ResearchPaper[]>([]);
  readonly internships          = signal<Internship[]>([]);
  readonly featuredBlogs        = signal<BlogListItem[]>([]);
  readonly studentStories       = signal<StudentStory[]>([]);
  readonly heroImageUrl         = signal(DEFAULT_HOME_HERO_IMAGE);

  readonly partneredColleges    = PARTNERED_COLLEGES;
  readonly learnerCollegesRow1  = LEARNER_COLLEGES_ROW1;
  readonly learnerCollegesRow2  = LEARNER_COLLEGES_ROW2;

  private readonly avatarColors = [
    'var(--purple)', 'var(--green)', 'var(--orange)', 'var(--blue)', 'var(--red)'
  ];

  // ── Hero rotating words ───────────────────────────────────────────────────
  readonly rotatingWords = [
    { text: 'Industry Mentors', color: 'var(--purple)' },
    { text: 'Expert Guidance',  color: 'var(--orange)' },
    { text: 'Real Projects',    color: 'var(--green)'  },
    { text: 'Career Support',   color: 'var(--blue)'   },
  ];

  readonly activeWordIndex = signal(0);
  private intervalId?: ReturnType<typeof setInterval>;

  readonly stats = [
    { value: '80K+', label: 'Learners',  color: 'var(--purple)' },
    { value: '25+',  label: 'Courses',   color: 'var(--green)'  },
    { value: '200+', label: 'Mentors',   color: 'var(--orange)' },
    { value: '4.8★',  label: 'Average Rating', color: 'var(--blue)'   },
  ];

  // ── About section ─────────────────────────────────────────────────────────
  readonly aboutPoints = [
    { text: 'Expert-led sessions with industry professionals', color: 'var(--green)'  },
    { text: 'Hands-on projects and portfolio building',  color: 'var(--purple)' },
    { text: 'Dedicated placement assistance',            color: 'var(--orange)' },
    { text: 'Flexible learning — learn at your own pace',color: 'var(--blue)'   },
    { text: 'Industry-recognised certificates',          color: 'var(--red)'    },
  ];

  // ── Research highlight ────────────────────────────────────────────────────
  readonly researchTags = [
    'Deep Learning', 'NLP', 'Computer Vision',
    'Reinforcement Learning', 'Generative AI'
  ];

  readonly researchStats = [
    { value: '3',   label: 'Months Duration',  color: 'var(--yellow)' },
    { value: '1000+',  label: 'Research Projects', color: 'var(--lgreen)' },
    { value: 'Industry', label: 'Experts',           color: 'var(--orange)' },
    { value: '250',   label: 'Publications',      color: 'var(--blue)'   },
  ];

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  ngOnInit(): void {
    this.courseService.getFeaturedCourses()
      .pipe(takeUntil(this.destroy$))
      .subscribe(c => this.featuredCourses.set(c));

    this.paperService.getFeaturedPapers()
      .pipe(takeUntil(this.destroy$))
      .subscribe(p => this.featuredPapers.set(p));

    this.internshipService.getInternships()
      .pipe(takeUntil(this.destroy$))
      .subscribe(i => this.internships.set(i.slice(0, 2)));

    this.blogService.getFeaturedBlogs(3)
      .pipe(takeUntil(this.destroy$))
      .subscribe(b => this.featuredBlogs.set(b));

    this.studentStoryService.getPublishedStories()
      .pipe(takeUntil(this.destroy$))
      .subscribe(stories => this.studentStories.set(stories));

    this.siteSettingsService.getHomeHeroImageUrl()
      .pipe(takeUntil(this.destroy$))
      .subscribe(url => {
        this.heroImageUrl.set(resolvePublicImageUrl(url));
      });

    this.intervalId = setInterval(() => {
      this.activeWordIndex.update(i => (i + 1) % this.rotatingWords.length);
    }, 2000);
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    if (this.intervalId) clearInterval(this.intervalId);
  }

  truncateImpression(text: string, max = 100): string {
    return text.length > max ? text.substring(0, max).trimEnd() + '…' : text;
  }

  collegeLogoSrc(logoUrl: string): string {
    return resolvePublicImageUrl(logoUrl, 256);
  }

  onLogoError(event: Event): void {
    const img = event.target as HTMLImageElement;
    img.style.visibility = 'hidden';
  }

  getInitials(name: string): string {
    return name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join('');
  }

  getAvatarColor(index: number): string {
    return this.avatarColors[index % this.avatarColors.length];
  }

  // ── Navigation ────────────────────────────────────────────────────────────
  goToCourses(): void { this.router.navigate(['/courses']); }
  goToInternships(): void { this.router.navigate(['/internships/short']); }
  goToResearch(): void { this.router.navigate(['/courses'], { queryParams: { research: 'true' } }); }
  goToAllCourses(): void { this.router.navigate(['/courses']); }
  goToAllPapers(): void { this.router.navigate(['/research-papers']); }
  goToAllBlogs(): void { this.router.navigate(['/blogs']); }
  goToBlog(slug: string): void { this.router.navigate(['/blogs', slug]); }
  goToRefer(): void { this.router.navigate(['/refer']); }
  goToCourse(slug: string): void { this.router.navigate(['/courses', slug]); }
  goToInternship(type: string): void { this.router.navigate(['/internships', type]); }

  // ── Helpers ───────────────────────────────────────────────────────────────
  getCategoryColor(cat: string): string {
    const map: Record<string, string> = {
      technical: 'var(--purple)',
      creative:  'var(--orange)',
      business:  'var(--green)',
    };
    return map[cat] ?? 'var(--purple)';
  }

  getCategoryTagBg(cat: string): string {
    const map: Record<string, string> = {
      technical: 'rgba(139,111,190,.12)',
      creative:  'rgba(244,132,95,.12)',
      business:  'rgba(76,175,80,.12)',
    };
    return map[cat] ?? 'rgba(139,111,190,.12)';
  }

  getCategoryEmoji(cat: string): string {
    const map: Record<string, string> = {
      technical: '💻',
      creative:  '🎨',
      business:  '📊',
    };
    return map[cat] ?? '📚';
  }

  getCategoryInfo(cat: string): { label: string; color: string; icon: string } {
    const map: Record<string, { label: string; color: string; icon: string }> = {
      ai:       { label: 'AI / ML',         color: 'var(--purple)', icon: '🤖' },
      nlp:      { label: 'NLP',             color: 'var(--blue)',   icon: '💬' },
      cv:       { label: 'Computer Vision', color: 'var(--orange)', icon: '👁️' },
      health:   { label: 'Healthcare AI',   color: 'var(--red)',    icon: '🏥' },
      business: { label: 'Business',        color: 'var(--green)',  icon: '📊' },
    };
    return map[cat] ?? { label: cat, color: 'var(--purple)', icon: '📄' };
  }

  formatPrice(price: number): string {
    return '₹' + price.toLocaleString('en-IN');
  }

  getDiscount(price: number, original: number): number {
    return Math.round((1 - price / original) * 100);
  }

  truncateAbstract(text: string, max = 160): string {
    return text.length > max ? text.substring(0, max) + '...' : text;
  }

  getTypeColor(type: string): string {
    return type === 'short' ? 'var(--blue)' : 'var(--purple)';
  }

  getTypeLabel(type: string): string {
    return type === 'short' ? 'Short Term' : 'Long Term';
  }

  getModeColor(mode: string): string {
    const map: Record<string, string> = {
      remote: 'var(--green)',
      hybrid: 'var(--orange)',
      onsite: 'var(--blue)',
    };
    return map[mode] ?? 'var(--muted)';
  }

  formatStipend(amount: number): string {
    return '₹' + amount.toLocaleString('en-IN') + '/mo';
  }

  formatBlogDate(date?: string): string {
    if (!date) return '';
    return new Date(date + 'T00:00:00').toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    });
  }
}