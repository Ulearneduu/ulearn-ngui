export interface StaffPermission {
  key: string;
  group: string;
  label: string;
}

export const STAFF_PERMISSIONS: StaffPermission[] = [
  { key: 'dashboard.view', group: 'Overview', label: 'Dashboard' },
  { key: 'courses.manage', group: 'Learning', label: 'Courses' },
  { key: 'curriculum.manage', group: 'Learning', label: 'Curriculum' },
  { key: 'batches.manage', group: 'Learning', label: 'Batches' },
  { key: 'sessions.manage', group: 'Learning', label: 'Sessions' },
  { key: 'students.manage', group: 'People', label: 'Students' },
  { key: 'enrollments.manage', group: 'People', label: 'Enrollments' },
  { key: 'mentors.manage', group: 'People', label: 'Mentor profiles' },
  { key: 'exams.manage', group: 'Exams', label: 'Exams' },
  { key: 'exam_registrations.manage', group: 'Exams', label: 'Exam registrations' },
  { key: 'coupons.manage', group: 'Site', label: 'Coupons' },
  { key: 'blogs.manage', group: 'Site', label: 'Blogs' },
  { key: 'internships.manage', group: 'Site', label: 'Internships' },
  { key: 'applications.manage', group: 'Site', label: 'Applications' },
  { key: 'papers.manage', group: 'Site', label: 'Papers' },
  { key: 'stories.manage', group: 'Site', label: 'Student stories' },
  { key: 'settings.manage', group: 'Control', label: 'Site settings' },
  { key: 'labels.manage', group: 'Control', label: 'Labels and members' },
  { key: 'promotions.send', group: 'Control', label: 'Promotion emails' },
  { key: 'crt.access', group: 'Student features', label: 'Allowed CRT' },
  { key: 'interview.access', group: 'Student features', label: 'Allowed Interview' },
  {
    key: 'interview_quota.manage',
    group: 'Student features',
    label: 'Manage interview weekly quota'
  },
  {
    key: 'interview.reviews',
    group: 'Student features',
    label: 'Review interview scores'
  }
];

export interface AdminNavItem {
  label: string;
  path: string;
  icon: string;
  permission: string;
}

export const ADMIN_NAV_ITEMS: AdminNavItem[] = [
  { label: 'Dashboard', path: '/admin/dashboard', icon: '📊', permission: 'dashboard.view' },
  { label: 'Courses', path: '/admin/courses', icon: '📚', permission: 'courses.manage' },
  { label: 'Curriculum', path: '/admin/curriculum', icon: '📋', permission: 'curriculum.manage' },
  { label: 'Enrollments', path: '/admin/enrollments', icon: '📝', permission: 'enrollments.manage' },
  { label: 'Coupons', path: '/admin/coupons', icon: '🏷️', permission: 'coupons.manage' },
  { label: 'Students', path: '/admin/students', icon: '👥', permission: 'students.manage' },
  { label: 'Batches', path: '/admin/batches', icon: '📅', permission: 'batches.manage' },
  { label: 'CRT', path: '/admin/crt/paths', icon: '🧠', permission: 'crt.access' },
  { label: 'Sessions', path: '/admin/sessions', icon: '🎥', permission: 'sessions.manage' },
  { label: 'Exam portal', path: '/admin/exam-portal', icon: '📝', permission: 'exams.manage' },
  { label: 'Mentors', path: '/admin/mentors', icon: '🧑‍🏫', permission: 'mentors.manage' },
  { label: 'Blogs', path: '/admin/blogs', icon: '📝', permission: 'blogs.manage' },
  { label: 'Internships', path: '/admin/internships', icon: '💼', permission: 'internships.manage' },
  { label: 'Applications', path: '/admin/internship-applications', icon: '📨', permission: 'applications.manage' },
  { label: 'Papers', path: '/admin/papers', icon: '📄', permission: 'papers.manage' },
  { label: 'Student Stories', path: '/admin/student-stories', icon: '⭐', permission: 'stories.manage' },
  { label: 'Labels', path: '/admin/labels', icon: '🔖', permission: 'labels.manage' },
  { label: 'Promotions', path: '/admin/promotions', icon: '✉️', permission: 'promotions.send' },
  { label: 'Settings', path: '/admin/settings', icon: '⚙️', permission: 'settings.manage' }
];

export function permissionGroups(): { group: string; items: StaffPermission[] }[] {
  const groups: { group: string; items: StaffPermission[] }[] = [];
  for (const item of STAFF_PERMISSIONS) {
    const existing = groups.find((group) => group.group === item.group);
    if (existing) existing.items.push(item);
    else groups.push({ group: item.group, items: [item] });
  }
  return groups;
}
