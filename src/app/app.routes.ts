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
    path: 'interview',
    canActivate: [authGuard, blockExamOnlyGuard, featurePermissionGuard],
    data: { permission: 'interview.access' },
    children: [
      {
        path: '',
        loadComponent: () => import('./interview/interview').then(m => m.Interview)
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