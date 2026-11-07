import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth-guard';
import { roleGuard } from './core/guards/role-guard';
import { featurePermissionGuard } from './core/guards/feature-permission-guard';
import { blockExamOnlyGuard } from './exam/guards/exam-guards';

export const routes: Routes = [
  // ─── Public ──────────────────────────────────────────────────────────────
  {
    path: '',
    canActivate: [blockExamOnlyGuard],
    loadComponent: () =>
      import('./public/home/home').then(m => m.Home)
  },
  {
    path: 'courses',
    canActivate: [blockExamOnlyGuard],
    loadComponent: () =>
      import('./public/courses/courses').then(m => m.Courses)
  },
  {
    path: 'learn/:courseSlug/:lessonId',
    loadComponent: () =>
      import('./public/learn/learn').then(m => m.Learn)
  },
  {
    path: 'courses/:slug',
    loadComponent: () =>
      import('./public/course-detail/course-detail').then(m => m.CourseDetail)
  },
  {
    path: 'internships/:type',
    loadComponent: () =>
      import('./public/internships/internships').then(m => m.Internships)
  },
  {
    path: 'research-papers',
    loadComponent: () =>
      import('./public/research-papers/research-papers').then(m => m.ResearchPapers)
  },
  {
    path: 'about',
    loadComponent: () =>
      import('./public/about/about').then(m => m.About)
  },
  {
    path: 'blogs',
    loadComponent: () =>
      import('./public/blogs/blogs').then(m => m.Blogs)
  },
  {
    path: 'blogs/:slug',
    loadComponent: () =>
      import('./public/blogs/blog-detail').then(m => m.BlogDetail)
  },
  {
    path: 'albums',
    redirectTo: 'blogs',
    pathMatch: 'full'
  },
  {
    path: 'refer',
    loadComponent: () =>
      import('./public/refer/refer').then(m => m.Refer)
  },
  {
    path: 'my-courses',
    canActivate: [authGuard, blockExamOnlyGuard],
    loadComponent: () =>
      import('./public/my-courses/my-courses').then(m => m.MyCourses)
  },
  {
    path: 's/join/:token',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./public/session-join/session-join').then(m => m.SessionJoin)
  },
  {
    path: 'profile',
    canActivate: [authGuard, blockExamOnlyGuard],
    loadComponent: () =>
      import('./public/my-profile/my-profile').then(m => m.MyProfile)
  },
  {
    path: 'crt',
    canActivate: [authGuard, blockExamOnlyGuard, featurePermissionGuard],
    data: { permission: 'crt.access' },
    loadComponent: () => import('./crt/crt').then(m => m.Crt)
  },
  {
    path: 'crt/paths/:pathId/modules',
    canActivate: [authGuard, blockExamOnlyGuard, featurePermissionGuard],
    data: { permission: 'crt.access' },
    loadComponent: () => import('./crt/modules/crt-modules').then(m => m.CrtModules)
  },
  {
    path: 'crt/paths/:pathId/modules/:moduleId/practice',
    canActivate: [authGuard, blockExamOnlyGuard, featurePermissionGuard],
    data: { permission: 'crt.access' },
    loadComponent: () => import('./crt/practice/crt-practice').then(m => m.CrtPractice)
  },
  {
    path: 'crt/paths/:pathId/modules/:moduleId/attempts/:attemptId/result',
    canActivate: [authGuard, blockExamOnlyGuard, featurePermissionGuard],
    data: { permission: 'crt.access' },
    loadComponent: () => import('./crt/result/crt-result').then(m => m.CrtResult)
  },
  {
    path: 'crt/mock/:pathId/attempts/:attemptId/result',
    canActivate: [authGuard, blockExamOnlyGuard, featurePermissionGuard],
    data: { permission: 'crt.access' },
    loadComponent: () =>
      import('./crt/mock-result/crt-mock-result').then(
        (m) => m.CrtMockResultComponent
      )
  },
  {
    path: 'crt/mock/:pathId',
    canActivate: [authGuard, blockExamOnlyGuard, featurePermissionGuard],
    data: { permission: 'crt.access' },
    loadComponent: () =>
      import('./crt/mock/crt-mock').then((m) => m.CrtMockComponent)
  },
  {
    path: 'crt/history',
    canActivate: [authGuard, blockExamOnlyGuard, featurePermissionGuard],
    data: { permission: 'crt.access' },
    loadComponent: () => import('./crt/history/crt-history').then(m => m.CrtHistory)
  },
  {
    path: 'crt/history/:attemptId',
    canActivate: [authGuard, blockExamOnlyGuard, featurePermissionGuard],
    data: { permission: 'crt.access' },
    loadComponent: () => import('./crt/review/crt-review').then(m => m.CrtReview)
  },
  {
    path: 'interview',
    canActivate: [authGuard, blockExamOnlyGuard, featurePermissionGuard],
    data: { permission: 'interview.access' },
    children: [
      {
        path: '',
        loadComponent: () => import('./interview/interview').then(m => m.Interview)
      },
      {
        path: 'history',
        loadComponent: () =>
          import('./interview/interview-history').then(m => m.InterviewHistory)
      },
      {
        path: 'session/:id/result',
        loadComponent: () =>
          import('./interview/interview-result').then(m => m.InterviewResult)
      },
      {
        path: 'session/:id/feedback',
        loadComponent: () =>
          import('./interview/interview-session-feedback').then(m => m.InterviewSessionFeedback)
      },
      {
        path: 'session/:id',
        loadComponent: () =>
          import('./interview/interview-session').then(m => m.InterviewSession)
      }
    ]
  },

  // ─── Exam portal (isolated) ───────────────────────────────────────────────
  {
    path: 'exam',
    loadChildren: () =>
      import('./exam/exam.routes').then(m => m.examRoutes)
  },

  // ─── Auth ─────────────────────────────────────────────────────────────────
  {
    path: 'auth',
    loadChildren: () =>
      import('./auth/auth.routes').then(m => m.authRoutes)
  },

  // ─── Admin (protected) ────────────────────────────────────────────────────
  {
    path: 'admin',
    canActivate: [authGuard, roleGuard],
    data: { role: 'ADMIN' },
    loadChildren: () =>
      import('./admin/admin.routes').then(m => m.adminRoutes)
  },

  // ─── Fallback ─────────────────────────────────────────────────────────────
  {
    path: '**',
    redirectTo: ''
  }
];