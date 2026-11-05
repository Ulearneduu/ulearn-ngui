import { Routes } from '@angular/router';
import { permissionGuard } from './guards/permission-guard';

function gated(
  path: string,
  permission: string,
  loadComponent: Routes[number]['loadComponent']
): Routes[number] {
  return { path, canActivate: [permissionGuard], data: { permission }, loadComponent };
}

export const adminRoutes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./admin-layout/admin-layout').then(m => m.AdminLayout),
    children: [
      gated('dashboard', 'dashboard.view', () =>
        import('./dashboard/dashboard').then(m => m.Dashboard)),
      gated('crt', 'dashboard.view', () =>
        import('./crt/crt').then(m => m.AdminCrt)),
      gated('interview', 'dashboard.view', () =>
        import('./interview/interview').then(m => m.AdminInterview)),
      gated('courses', 'courses.manage', () =>
        import('./courses-management/courses-management').then(m => m.CoursesManagement)),
      gated('curriculum', 'curriculum.manage', () =>
        import('./curriculum-builder/curriculum-builder').then(m => m.CurriculumBuilder)),
      gated('curriculum/lesson/:lessonId', 'curriculum.manage', () =>
        import('./lesson-content-editor/lesson-content-editor').then(m => m.LessonContentEditor)),
      gated('mentors', 'mentors.manage', () =>
        import('./mentors-management/mentors-management').then(m => m.MentorsManagement)),
      gated('internships', 'internships.manage', () =>
        import('./internships-management/internships-management').then(m => m.InternshipsManagement)),
      gated('internship-applications', 'applications.manage', () =>
        import('./internship-applications-management/internship-applications-management').then(
          m => m.InternshipApplicationsManagement
        )),
      gated('papers', 'papers.manage', () =>
        import('./papers-management/papers-management').then(m => m.PapersManagement)),
      gated('student-stories', 'stories.manage', () =>
        import('./student-stories-management/student-stories-management').then(
          m => m.StudentStoriesManagement
        )),
      gated('blogs', 'blogs.manage', () =>
        import('./blogs-management/blogs-management').then(m => m.BlogsManagement)),
      { path: 'albums', redirectTo: 'blogs', pathMatch: 'full' },
      gated('students', 'students.manage', () =>
        import('./students/students').then(m => m.Students)),
      gated('batches', 'batches.manage', () =>
        import('./batches-management/batches-management').then(m => m.BatchesManagement)),
      gated('batches/:batchId', 'batches.manage', () =>
        import('./batch-detail/batch-detail').then(m => m.BatchDetail)),
      { path: 'crt', redirectTo: '/admin/crt/paths', pathMatch: 'full' },
      gated('crt/paths', 'crt.access', () =>
        import('./crt/learning-paths/learning-paths').then(m => m.CrtLearningPaths)),
      gated('crt/paths/:pathId/modules', 'crt.access', () =>
        import('./crt/path-modules/path-modules').then(m => m.CrtPathModules)),
      gated('crt/questions', 'crt.access', () =>
        import('./crt/questions/crt-questions').then(m => m.CrtQuestions)),
      gated('crt/assignments', 'crt.access', () =>
        import('./crt/assignments/crt-assignments').then(m => m.CrtAssignments)),
      gated('sessions', 'sessions.manage', () =>
        import('./sessions-management/sessions-management').then(m => m.SessionsManagement)),
      gated('sessions/schedule', 'sessions.manage', () =>
        import('./schedule-session/schedule-session').then(m => m.ScheduleSession)),
      gated('sessions/:sessionId', 'sessions.manage', () =>
        import('./session-detail/session-detail').then(m => m.SessionDetail)),
      {
        path: 'exam-portal',
        canActivate: [permissionGuard],
        data: { anyPermission: ['exams.manage', 'exam_registrations.manage'] },
        loadComponent: () => import('./exam-portal/exam-portal-list').then(m => m.ExamPortalList)
      },
      {
        path: 'exam-portal/:eventId',
        canActivate: [permissionGuard],
        data: { anyPermission: ['exams.manage', 'exam_registrations.manage'] },
        loadComponent: () => import('./exam-portal/exam-event-detail').then(m => m.ExamEventDetail)
      },
      { path: 'exams/registrations', redirectTo: 'exam-portal', pathMatch: 'full' },
      { path: 'exams', redirectTo: 'exam-portal', pathMatch: 'full' },
      gated('exams/:examId', 'exams.manage', () =>
        import('./exam-detail/exam-detail').then(m => m.ExamDetail)),
      gated('enrollments', 'enrollments.manage', () =>
        import('./enrollments-management/enrollments-management').then(m => m.EnrollmentsManagement)),
      gated('coupons', 'coupons.manage', () =>
        import('./discount-coupons-management/discount-coupons-management').then(
          m => m.DiscountCouponsManagement
        )),
      gated('labels', 'labels.manage', () =>
        import('./labels/labels-management').then(m => m.LabelsManagement)),
      gated('promotions', 'promotions.send', () =>
        import('./promotions/promotions').then(m => m.Promotions)),
      gated('settings', 'settings.manage', () =>
        import('./settings/settings').then(m => m.Settings)),
      {
        path: 'no-access',
        loadComponent: () => import('./no-access/no-access').then(m => m.NoAccess)
      },
      { path: '', redirectTo: 'dashboard', pathMatch: 'full' }
    ]
  }
];
