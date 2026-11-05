import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

export function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

export type ProductKind = 'course' | 'internship';

export function parseExclusiveProductId(body: {
  courseId?: string;
  internshipId?: string;
}):
  | { ok: true; kind: ProductKind; id: string }
  | { ok: false; error: string } {
  const courseId = typeof body.courseId === 'string' ? body.courseId.trim() : '';
  const internshipId = typeof body.internshipId === 'string' ? body.internshipId.trim() : '';
  const hasCourse = courseId.length > 0;
  const hasInternship = internshipId.length > 0;

  if (hasCourse && hasInternship) {
    return { ok: false, error: 'Specify either courseId or internshipId, not both' };
  }
  if (!hasCourse && !hasInternship) {
    return { ok: false, error: 'Product id required' };
  }
  if (hasCourse) return { ok: true, kind: 'course', id: courseId };
  return { ok: true, kind: 'internship', id: internshipId };
}

export function rupeesToPaise(rupees: number): number {
  if (!Number.isFinite(rupees) || rupees < 0) return 0;
  return Math.max(0, Math.round(rupees * 100));
}

/** Final rupees after percentage discount; never negative. */
export function applyCouponDiscountRupees(baseRupees: number, discountPercent: number): number {
  if (!Number.isFinite(baseRupees) || baseRupees <= 0) return 0;
  if (!Number.isFinite(discountPercent) || discountPercent <= 0) {
    return Math.round(baseRupees);
  }
  const pct = Math.min(100, Math.max(0, discountPercent));
  return Math.max(0, Math.round(baseRupees * (1 - pct / 100)));
}

export interface CouponValidation {
  valid: boolean;
  discountPercent: number;
  message: string;
}

export async function validateCouponServer(
  adminClient: SupabaseClient,
  couponCode: string | undefined
): Promise<CouponValidation> {
  const code = couponCode?.trim();
  if (!code) {
    return { valid: false, discountPercent: 0, message: '' };
  }

  const { data, error } = await adminClient.rpc('validate_coupon', { p_code: code });
  if (error) {
    return { valid: false, discountPercent: 0, message: 'Could not validate coupon' };
  }

  const raw = data as Record<string, unknown> | null;
  if (!raw?.['valid']) {
    return {
      valid: false,
      discountPercent: 0,
      message: String(raw?.['message'] ?? 'Invalid coupon code')
    };
  }

  const discountPercent = Number(raw['discount_percentage'] ?? 0);
  return {
    valid: true,
    discountPercent: Number.isFinite(discountPercent) ? discountPercent : 0,
    message: String(raw['message'] ?? 'Coupon applied')
  };
}

export interface ProductPriceResult {
  ok: true;
  baseRupees: number;
  title: string;
}
export interface ProductPriceError {
  ok: false;
  error: string;
  status: number;
}

export async function fetchProductPrice(
  adminClient: SupabaseClient,
  kind: ProductKind,
  productId: string
): Promise<ProductPriceResult | ProductPriceError> {
  if (kind === 'course') {
    const { data, error } = await adminClient
      .from('courses')
      .select('id, title, price, status')
      .eq('id', productId)
      .maybeSingle();

    if (error || !data) {
      return { ok: false, error: 'Course not found', status: 404 };
    }
    if (data.status !== 'published') {
      return { ok: false, error: 'Course is not available for enrollment', status: 400 };
    }
    const baseRupees = Number(data.price ?? 0);
    return { ok: true, baseRupees: Number.isFinite(baseRupees) ? baseRupees : 0, title: String(data.title) };
  }

  const { data, error } = await adminClient
    .from('internships')
    .select('id, title, price, status')
    .eq('id', productId)
    .maybeSingle();

  if (error || !data) {
    return { ok: false, error: 'Internship not found', status: 404 };
  }
  if (data.status !== 'open') {
    return { ok: false, error: 'Internship is not open for enrollment', status: 400 };
  }
  const baseRupees = Number(data.price ?? 0);
  return { ok: true, baseRupees: Number.isFinite(baseRupees) ? baseRupees : 0, title: String(data.title) };
}

export interface CourseEnrollmentDetails {
  fullName: string;
  phone: string;
  email: string;
  collegeName: string;
  degree: string;
  degreeYear: number;
  specialization: string;
  liveClassStartMonth: string;
}

export interface InternshipEnrollmentDetails {
  fullName: string;
  phone: string;
  email: string;
  collegeName: string;
  degree: string;
  graduationYear: number;
  specialization: string;
}

const PHONE_PATTERN = /^\+?[0-9]{10,15}$/;

function isNonEmptyString(v: unknown, min = 1): v is string {
  return typeof v === 'string' && v.trim().length >= min;
}

export function validateCourseEnrollmentDetails(
  details: unknown
): { ok: true; value: CourseEnrollmentDetails } | { ok: false; error: string } {
  if (!details || typeof details !== 'object') {
    return { ok: false, error: 'Enrollment details are required' };
  }
  const d = details as Record<string, unknown>;
  if (!isNonEmptyString(d.fullName, 2)) return { ok: false, error: 'Full name is required' };
  if (!isNonEmptyString(d.phone) || !PHONE_PATTERN.test(String(d.phone).trim())) {
    return { ok: false, error: 'Valid phone is required' };
  }
  if (!isNonEmptyString(d.email) || !String(d.email).includes('@')) {
    return { ok: false, error: 'Valid email is required' };
  }
  if (!isNonEmptyString(d.collegeName, 2)) return { ok: false, error: 'College is required' };
  if (!isNonEmptyString(d.degree)) return { ok: false, error: 'Degree is required' };
  const degreeYear = Number(d.degreeYear);
  if (!Number.isFinite(degreeYear)) return { ok: false, error: 'Degree year is required' };
  if (!isNonEmptyString(d.specialization, 2)) {
    return { ok: false, error: 'Specialization is required' };
  }
  if (!isNonEmptyString(d.liveClassStartMonth)) {
    return { ok: false, error: 'Live class start month is required' };
  }

  return {
    ok: true,
    value: {
      fullName: String(d.fullName).trim(),
      phone: String(d.phone).trim(),
      email: String(d.email).trim(),
      collegeName: String(d.collegeName).trim(),
      degree: String(d.degree).trim(),
      degreeYear,
      specialization: String(d.specialization).trim(),
      liveClassStartMonth: String(d.liveClassStartMonth).trim()
    }
  };
}

export function validateInternshipEnrollmentDetails(
  details: unknown
): { ok: true; value: InternshipEnrollmentDetails } | { ok: false; error: string } {
  if (!details || typeof details !== 'object') {
    return { ok: false, error: 'Enrollment details are required' };
  }
  const d = details as Record<string, unknown>;
  if (!isNonEmptyString(d.fullName, 2)) return { ok: false, error: 'Full name is required' };
  if (!isNonEmptyString(d.phone) || !PHONE_PATTERN.test(String(d.phone).trim())) {
    return { ok: false, error: 'Valid phone is required' };
  }
  if (!isNonEmptyString(d.email) || !String(d.email).includes('@')) {
    return { ok: false, error: 'Valid email is required' };
  }
  if (!isNonEmptyString(d.collegeName, 2)) return { ok: false, error: 'College is required' };
  if (!isNonEmptyString(d.degree)) return { ok: false, error: 'Degree is required' };
  const graduationYear = Number(d.graduationYear);
  if (!Number.isFinite(graduationYear)) return { ok: false, error: 'Graduation year is required' };
  if (!isNonEmptyString(d.specialization, 2)) {
    return { ok: false, error: 'Specialization is required' };
  }

  return {
    ok: true,
    value: {
      fullName: String(d.fullName).trim(),
      phone: String(d.phone).trim(),
      email: String(d.email).trim(),
      collegeName: String(d.collegeName).trim(),
      degree: String(d.degree).trim(),
      graduationYear,
      specialization: String(d.specialization).trim()
    }
  };
}

export async function verifyRazorpaySignature(
  orderId: string,
  paymentId: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${orderId}|${paymentId}`));
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return expected === signature;
}

export interface RazorpayPaymentRecord {
  id?: string;
  order_id?: string;
  amount?: number;
  currency?: string;
  status?: string;
  error?: { description?: string; code?: string };
}

export {
  normalizeVerifyPaymentStrings,
  validatePaymentOrderProductMatch,
  validatePaymentOrderStatusForVerify,
  validateRazorpayOrderForFinalize,
  validateRazorpayPaymentForFinalize,
  validateVerifyRequestProductIds
} from './enrollment-payment-validation.mjs';

export function courseEnrollmentDetailsToJson(
  details: CourseEnrollmentDetails
): Record<string, string | number> {
  return {
    full_name: details.fullName,
    phone: details.phone,
    email: details.email,
    college_name: details.collegeName,
    degree: details.degree,
    degree_year: details.degreeYear,
    specialization: details.specialization,
    live_class_start_month: details.liveClassStartMonth
  };
}

export function internshipEnrollmentDetailsToJson(
  details: InternshipEnrollmentDetails
): Record<string, string | number> {
  return {
    full_name: details.fullName,
    phone: details.phone,
    email: details.email,
    college_name: details.collegeName,
    degree: details.degree,
    graduation_year: details.graduationYear,
    specialization: details.specialization
  };
}

export function parseFinalizeRpcResult(data: unknown): {
  success: boolean;
  alreadyEnrolled?: boolean;
  error?: string;
} {
  const raw = data as Record<string, unknown> | null;
  if (!raw) return { success: false, error: 'Empty finalize response' };
  if (raw['success'] === true) {
    return {
      success: true,
      alreadyEnrolled: Boolean(raw['already_enrolled'])
    };
  }
  return { success: false, error: String(raw['error'] ?? 'Finalize failed') };
}

export async function requireAuthenticatedUser(req: Request): Promise<
  | { ok: true; userId: string; authHeader: string }
  | { ok: false; response: Response }
> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return { ok: false, response: json({ error: 'Unauthorized' }, 401) };
  }

  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } }
  );

  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) {
    return { ok: false, response: json({ error: 'Unauthorized' }, 401) };
  }

  return { ok: true, userId: user.id, authHeader };
}

export function createAdminClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );
}
