// ─── USER & AUTH ─────────────────────────────────────────────────────────────

export type UserRole = 'USER' | 'ADMIN';

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  avatarUrl?: string;
  createdAt: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  user: User;
  tokens: AuthTokens;
}

export interface RegisterRequest {
  name: string;
  email: string;
  password: string;
  phone?: string;
}

// ─── COURSES ─────────────────────────────────────────────────────────────────

export type CourseCategory = 'technical' | 'creative' | 'business';
export type CourseStatus = 'draft' | 'published' | 'archived';

export interface CurriculumLesson {
  id: string;
  title: string;
  description: string;
  durationMinutes: number;
  videoUrl?: string;
  resourceUrl?: string;
  resourceType?: 'video' | 'file';
  isFree: boolean;
  order: number;
}

export type ContentBlockType =
  | 'heading'
  | 'text'
  | 'image'
  | 'two_column'
  | 'callout'
  | 'code'
  | 'quote'
  | 'divider'
  | 'gallery'
  | 'video';

export interface ContentBlock {
  id: string;
  type: ContentBlockType;
  orderIndex: number;
  content: Record<string, unknown>;
}

export interface LessonWithBlocks extends CurriculumLesson {
  contentBlocks: ContentBlock[];
  moduleId: string;
  moduleOrder: number;
}

export interface LessonProgress {
  lessonId: string;
  completed: boolean;
  completedAt?: string;
}

export interface CurriculumModule {
  id: string;
  title: string;
  description: string;
  order: number;
  lessons: CurriculumLesson[];
}

export interface Mentor {
  id: string;
  name: string;
  role: string;
  company: string;
  bio: string;
  avatarUrl?: string;
  linkedInUrl?: string;
}

export type CourseFormat = '45-day' | '3-month';

export interface Course {
  id: string;
  slug: string;
  title: string;
  description: string;
  category: CourseCategory;
  status: CourseStatus;
  thumbnailUrl?: string;
  price: number;
  originalPrice: number;
  durationMonths: number;
  durationDays?: number;
  weeklyHours?: number;
  /** Mapped from DB live_class_count */
  classCount?: number;
  hoursPerClass?: number;
  courseFormat?: CourseFormat;
  totalLessons: number;
  rating: number;
  totalStudents: number;
  curriculum: CurriculumModule[];
  mentors: Mentor[];
  isResearchCourse: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CourseListItem {
  id: string;
  slug: string;
  title: string;
  category: CourseCategory;
  status: CourseStatus;
  thumbnailUrl?: string;
  price: number;
  originalPrice: number;
  durationMonths: number;
  durationDays?: number;
  weeklyHours?: number;
  /** Mapped from DB live_class_count */
  classCount?: number;
  hoursPerClass?: number;
  courseFormat?: CourseFormat;
  totalLessons: number;
  rating: number;
  totalStudents: number;
  isResearchCourse: boolean;
}

// ─── INTERNSHIPS ─────────────────────────────────────────────────────────────

export type InternshipType = 'short' | 'long';
export type InternshipMode = 'remote' | 'hybrid' | 'onsite';

export interface Internship {
  id: string;
  title: string;
  type: InternshipType;
  mode: InternshipMode;
  domain: string;
  description: string;
  durationLabel: string;
  stipendPerMonth: number;
  hasPPO: boolean;
  skills: string[];
  thumbnailUrl?: string;
  status: 'open' | 'closed';
  createdAt: string;
}

export type InternshipApplicationStatus =
  | 'applied'
  | 'reviewing'
  | 'accepted'
  | 'rejected';

export interface InternshipApplication {
  id: string;
  internshipId: string;
  userId: string;
  status: InternshipApplicationStatus;
  appliedAt: string;
  updatedAt: string;
}

// ─── RESEARCH PAPERS ─────────────────────────────────────────────────────────

export type PaperStatus = 'published' | 'under_review' | 'preprint';
export type PaperCategory = 'ai' | 'nlp' | 'cv' | 'health' | 'business';

export interface ResearchPaper {
  id: string;
  title: string;
  authors: string[];
  abstract: string;
  category: PaperCategory;
  status: PaperStatus;
  venue: string;
  year: number;
  pdfUrl?: string;
  doiUrl?: string;
  citations: number;
  thumbnailUrl?: string;
  createdAt: string;
}

// ─── STUDENT STORIES ─────────────────────────────────────────────────────────

export interface StudentStory {
  id: string;
  studentName: string;
  photoUrl?: string;
  collegeName: string;
  currentRole?: string;
  impression: string;
  sortOrder: number;
  isPublished: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── BLOGS ───────────────────────────────────────────────────────────────────

export type BlogStatus = 'draft' | 'published';

export interface BlogImage {
  id: string;
  url: string;
  caption?: string;
  order: number;
}

export interface Blog {
  id: string;
  slug: string;
  title: string;
  summary?: string;
  content: string;
  coverImageUrl?: string;
  images: BlogImage[];
  eventDate?: string;
  status: BlogStatus;
  createdAt: string;
  updatedAt: string;
}

export interface BlogListItem {
  id: string;
  slug: string;
  title: string;
  summary?: string;
  coverImageUrl?: string;
  /** Cover image or first gallery image for cards */
  thumbnailUrl?: string;
  eventDate?: string;
  createdAt: string;
}

// ─── STUDENTS ────────────────────────────────────────────────────────────────

export type EnrollmentStatus = 'active' | 'completed' | 'refunded';

export interface Enrollment {
  id: string;
  courseId: string;
  courseTitle: string;
  enrolledAt: string;
  status: EnrollmentStatus;
  progressPercent: number;
}

export interface DiscountCoupon {
  id: string;
  code: string;
  discountPercentage: number;
  active: boolean;
  expiresAt?: string;
  maxUses?: number;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ValidateCouponResult {
  valid: boolean;
  discountPercentage?: number;
  message: string;
}

export interface EnrollmentFormData {
  fullName: string;
  phone: string;
  email: string;
  collegeName: string;
  degree: string;
  degreeYear: number;
  specialization: string;
  liveClassStartMonth: string;
  couponCode?: string;
  couponDiscountPercent?: number;
}

export interface ModuleUnlock {
  id: string;
  enrollmentId: string;
  moduleId: string;
  unlockedAt: string;
}

// ─── BATCHES ─────────────────────────────────────────────────────────────────

export type BatchStatus = 'active' | 'completed' | 'archived';

export interface Batch {
  id: string;
  courseId: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
  status: BatchStatus;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BatchMemberRow {
  id: string;
  batchId: string;
  userId: string;
  userName: string;
  userEmail: string | null;
  addedAt: string;
}

export interface StudentBatchSummary {
  batchId: string;
  batchName: string;
  courseTitle: string;
}

// ─── LIVE SESSIONS ───────────────────────────────────────────────────────────

export type LiveSessionStatus = 'scheduled' | 'live' | 'ended' | 'cancelled';
export type SessionRole = 'instructor' | 'moderator' | 'student';
export type SessionStudentPermission = 'audio' | 'audio_video' | 'writing';
export type SessionType = 'one_time' | 'permanent';
export type SessionPlace = 'virtual' | 'external' | 'in_person';

export interface SessionRecurrenceConfig {
  enabled: boolean;
  repeatDays: boolean[];
  endDate: string;
}

export interface LiveSession {
  id: string;
  batchId: string;
  courseId: string;
  title: string;
  description: string | null;
  scheduledAt: string;
  durationMinutes: number;
  status: LiveSessionStatus;
  livekitRoomName: string;
  hostUserId: string | null;
  createdBy: string | null;
  startedAt: string | null;
  endedAt: string | null;
  maxParticipants: number | null;
  defaultStudentPermission: SessionStudentPermission;
  allowGuestJoin: boolean;
  isolateStudents: boolean;
  allowStudentMic: boolean;
  allowStudentCamera: boolean;
  allowStudentUnmute: boolean;
  sessionType: SessionType;
  sessionPlace: SessionPlace;
  timezone: string;
  recurrenceConfig: SessionRecurrenceConfig | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRoomSettings {
  allowStudentMic: boolean;
  allowStudentCamera: boolean;
  allowStudentUnmute: boolean;
  isolateStudents: boolean;
}

export interface ExcalidrawPersistedScene {
  elements: unknown[];
  appState: Record<string, unknown>;
  files?: Record<string, unknown>;
}

export interface SessionBoardRow {
  id: string;
  sessionId: string;
  boardKey: string;
  scene: ExcalidrawPersistedScene;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionInvite {
  id: string;
  sessionId: string;
  role: SessionRole;
  token: string;
  revoked: boolean;
  createdAt: string;
}

export interface StudentLiveSession {
  id: string;
  batchId: string;
  batchName: string;
  courseId: string;
  title: string;
  description: string | null;
  scheduledAt: string;
  durationMinutes: number;
  status: LiveSessionStatus;
  studentJoinToken: string | null;
  canJoin: boolean;
}

export interface UserEnrolledCourse {
  enrollmentId: string;
  courseId: string;
  slug: string;
  title: string;
  category: CourseCategory;
  thumbnailUrl?: string;
  totalLessons: number;
  classCount?: number;
  hoursPerClass?: number;
  progress: number;
  enrolledAt: string;
  firstLessonId?: string;
}

export interface Student {
  id: string;
  name: string;
  email: string;
  phone?: string;
  avatarUrl?: string;
  enrollments: Enrollment[];
  totalReferrals: number;
  referralEarnings: number;
  joinedAt: string;
}

// ─── REFERRAL ────────────────────────────────────────────────────────────────

export interface Referral {
  id: string;
  referrerUserId: string;
  referredEmail: string;
  courseId: string;
  courseTitle: string;
  status: 'pending' | 'converted' | 'paid';
  earnedAmount: number;
  createdAt: string;
}

// ─── SHARED ───────────────────────────────────────────────────────────────────

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ApiError {
  status: number;
  message: string;
  errors?: Record<string, string[]>;
}

export interface SelectOption<T = string> {
  label: string;
  value: T;
}

export interface UploadResponse {
  key: string;
  url: string;
}

export interface DashboardStats {
  totalStudents: number;
  totalCourses: number;
  totalRevenue: number;
  totalEnrollmentsThisMonth: number;
  totalPapersPublished: number;
  activeInternships: number;
  pendingReferrals: number;
  newStudentsThisWeek: number;
}

// ─── EXAM PORTAL ─────────────────────────────────────────────────────────────

export type ExamStatus = 'draft' | 'published' | 'closed';
export type ExamQuestionType = 'mcq' | 'coding';
export type ExamAttemptStatus = 'in_progress' | 'submitted' | 'auto_submitted' | 'blocked';

export interface Exam {
  id: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  maxConcurrent: number;
  status: ExamStatus;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  eventId?: string | null;
}

export interface ExamRole {
  id: string;
  examId: string;
  name: string;
  slug: string;
  hasCoding: boolean;
  sortOrder: number;
  createdAt: string;
}

export interface ExamMcqPayload {
  stem: string;
  codeBlock?: string;
  options: string[];
  correctIndex: number;
  marks: number;
}

export interface ExamCodingPayload {
  title: string;
  description: string;
  starterCode?: string;
  language: string;
  marks: number;
  publicTestCases?: ExamTestCase[];
  hiddenTestCases?: ExamTestCase[];
}

export interface ExamTestCase {
  input: string;
  expectedOutput: string;
}

export interface ExamQuestion {
  id: string;
  examRoleId: string;
  type: ExamQuestionType;
  sortOrder: number;
  payload: ExamMcqPayload | ExamCodingPayload;
  createdAt: string;
}

export interface ExamCandidate {
  id: string;
  examId: string;
  userId: string;
  examRoleId: string;
  registeredAt: string;
  credentialsSentAt: string | null;
  exam?: Exam;
  role?: ExamRole;
}

export interface ExamAttempt {
  id: string;
  examId: string;
  examRoleId: string;
  userId: string;
  startedAt: string;
  endsAt: string;
  submittedAt: string | null;
  status: ExamAttemptStatus;
  fullscreenExitCount: number;
  proctoringConsentAt: string | null;
  createdAt: string;
}

export interface ExamAnswer {
  id: string;
  attemptId: string;
  questionId: string;
  answer: Record<string, unknown>;
  answeredAt: string;
}

export interface ExamUpsertInput {
  title: string;
  description?: string | null;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  maxConcurrent?: number;
  status?: ExamStatus;
}

export interface ExamCandidateImportRow {
  email: string;
  fullName: string;
  phone?: string;
  collegeName?: string;
  roleSlug: string;
}

export interface ExamQuestionImportInput {
  type: ExamQuestionType;
  sortOrder: number;
  payload: ExamMcqPayload | ExamCodingPayload;
}

export interface ExamRegistration {
  id: string;
  email: string;
  fullName: string;
  roleInterested: string;
  roleSlug: string | null;
  examId: string | null;
  userId: string | null;
  candidateId: string | null;
  importBatchId: string | null;
  credentialsSentAt: string | null;
  provisionError: string | null;
  createdAt: string;
  examTitle?: string;
  fromMultipleRoles?: boolean;
}

export interface ExamMcqBreakdownItem {
  questionId: string;
  selectedIndex?: number | null;
  correctIndex: number;
  marks: number;
  earned: number;
}

export interface ExamCodingBreakdownItem {
  questionId: string;
  passedTests: number;
  totalTests: number;
  marks: number;
  earned: number;
}

export interface ExamResultRow {
  id: string;
  attemptId: string;
  examId: string;
  userId: string;
  roleSlug: string;
  studentName: string;
  studentEmail: string;
  mcqScore: number;
  mcqMax: number;
  codingScore: number;
  codingMax: number;
  totalScore: number;
  totalMax: number;
  percentage: number;
  fullscreenWarnings: number;
  evaluatedAt: string;
  attemptStartedAt?: string | null;
  attemptSubmittedAt?: string | null;
  attemptStatus?: string | null;
  attemptEndsAt?: string | null;
  mcqBreakdown?: ExamMcqBreakdownItem[];
  codingBreakdown?: ExamCodingBreakdownItem[];
}

/** Registered candidate with account who never started an exam attempt. */
export interface ExamNotAttendedRow {
  id: string;
  email: string;
  fullName: string;
  roleInterested: string;
  roleSlug: string | null;
  examId: string | null;
  examTitle?: string;
  credentialsSentAt: string | null;
  createdAt: string;
}

/** Admin recruitment portal summary (matches role + exam filters). */
export interface ExamPortalStats {
  registrations: number;
  submitted: number;
  notStarted: number;
  inProgress: number;
  notProvisioned: number;
}

export type ExamAssignmentFilter = 'all' | 'multiple-roles' | 'single-role';
export type ExamMultiExamFilter = 'all' | 'multi-exam' | 'multi-exam-other';

export interface ExamPortalFilterParams {
  roleSlug?: string;
  examId?: string;
  examIds?: string[];
  assignmentFilter?: ExamAssignmentFilter;
  multiExamFilter?: ExamMultiExamFilter;
}

export interface ExamResultQuestionReview {
  question: ExamQuestion;
  answer: Record<string, unknown> | null;
  mcqBreakdown?: ExamMcqBreakdownItem;
  codingBreakdown?: ExamCodingBreakdownItem;
}

export interface ExamResultDetail {
  result: ExamResultRow;
  questions: ExamResultQuestionReview[];
}

// ─── INTERVIEW ───────────────────────────────────────────────────────────────

export type InterviewTemplateKind = 'hr' | 'technical' | 'domain';

export type InterviewSessionStatus = 'in_progress' | 'completed' | 'failed';

/** Published interview template shown in the student catalog. */
export interface InterviewTemplate {
  id: string;
  slug: string;
  title: string;
  kind: InterviewTemplateKind;
  durationMinutes: number;
  createdAt: string;
}

/** Session row created when a student starts a template. */
export interface InterviewSessionSummary {
  id: string;
  status: InterviewSessionStatus;
  templateId: string;
  templateTitle: string;
  templateKind: InterviewTemplateKind;
  promptVersion: string;
}