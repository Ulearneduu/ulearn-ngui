/**
 * Shared pure validators for Razorpay verify flow (Node tests + Deno edge functions).
 */

/**
 * @param {{
 *   razorpay_order_id?: unknown;
 *   razorpay_payment_id?: unknown;
 *   razorpay_signature?: unknown;
 * }} body
 */
export function normalizeVerifyPaymentStrings(body) {
  const razorpay_order_id =
    typeof body.razorpay_order_id === 'string' ? body.razorpay_order_id.trim() : '';
  const razorpay_payment_id =
    typeof body.razorpay_payment_id === 'string' ? body.razorpay_payment_id.trim() : '';
  const razorpay_signature =
    typeof body.razorpay_signature === 'string' ? body.razorpay_signature.trim() : '';

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return { ok: false, error: 'Missing payment details' };
  }

  return {
    ok: true,
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature
  };
}

/**
 * @param {{ courseId?: string; internshipId?: string }} body
 */
export function validateVerifyRequestProductIds(body) {
  const courseId = typeof body.courseId === 'string' ? body.courseId.trim() : '';
  const internshipId = typeof body.internshipId === 'string' ? body.internshipId.trim() : '';
  const hasCourse = courseId.length > 0;
  const hasInternship = internshipId.length > 0;

  if (hasCourse && hasInternship) {
    return { ok: false, error: 'Specify either courseId or internshipId, not both' };
  }
  if (!hasCourse && !hasInternship) {
    return { ok: false, error: 'courseId or internshipId is required' };
  }
  if (hasCourse) {
    return { ok: true, courseId, internshipId: undefined };
  }
  return { ok: true, courseId: undefined, internshipId };
}

/**
 * @param {{ product_type: string; course_id?: string | null; internship_id?: string | null }} order
 * @param {{ courseId?: string; internshipId?: string }} ids
 */
export function validatePaymentOrderProductMatch(order, ids) {
  if (ids.courseId) {
    if (order.product_type !== 'course') {
      return { ok: false, error: 'Payment order is not a course order' };
    }
    if (order.course_id !== ids.courseId) {
      return { ok: false, error: 'Course does not match payment order' };
    }
    return { ok: true };
  }

  if (ids.internshipId) {
    if (order.product_type !== 'internship') {
      return { ok: false, error: 'Payment order is not an internship order' };
    }
    if (order.internship_id !== ids.internshipId) {
      return { ok: false, error: 'Internship does not match payment order' };
    }
    return { ok: true };
  }

  return { ok: false, error: 'Product id required' };
}

/** @param {string} status */
export function validatePaymentOrderStatusForVerify(status) {
  if (status === 'pending' || status === 'paid') {
    return { ok: true };
  }
  if (status === 'failed') {
    return { ok: false, error: 'Payment order has failed' };
  }
  if (status === 'expired') {
    return { ok: false, error: 'Payment order has expired' };
  }
  return { ok: false, error: 'Payment order is not payable' };
}

/**
 * @param {{
 *   apiOk: boolean;
 *   order: Record<string, unknown> | null;
 *   submittedOrderId: string;
 *   expectedAmountPaise: number;
 *   expectedCurrency: string;
 * }} input
 */
export function validateRazorpayOrderForFinalize(input) {
  if (!input.apiOk || !input.order || input.order.error) {
    return { ok: false, error: 'Could not verify Razorpay order' };
  }

  if (input.order.id !== input.submittedOrderId) {
    return { ok: false, error: 'Razorpay order id mismatch' };
  }

  if (Number(input.order.amount) !== input.expectedAmountPaise) {
    return { ok: false, error: 'Payment amount mismatch' };
  }

  if (input.order.currency !== input.expectedCurrency) {
    return { ok: false, error: 'Payment currency mismatch' };
  }

  return { ok: true };
}

/**
 * @param {{
 *   apiOk: boolean;
 *   payment: Record<string, unknown> | null;
 *   submittedPaymentId: string;
 *   submittedOrderId: string;
 *   expectedAmountPaise: number;
 *   expectedCurrency: string;
 * }} input
 */
export function validateRazorpayPaymentForFinalize(input) {
  if (!input.apiOk || !input.payment || input.payment.error) {
    const desc =
      input.payment && typeof input.payment.error === 'object' && input.payment.error !== null
        ? /** @type {{ description?: string }} */ (input.payment.error).description
        : undefined;
    return {
      ok: false,
      error: desc ? `Could not verify Razorpay payment: ${desc}` : 'Could not verify Razorpay payment'
    };
  }

  const pay = input.payment;

  if (pay.id !== input.submittedPaymentId) {
    return { ok: false, error: 'Payment id mismatch' };
  }

  if (pay.order_id !== input.submittedOrderId) {
    return { ok: false, error: 'Payment belongs to a different order' };
  }

  if (Number(pay.amount) !== input.expectedAmountPaise) {
    return { ok: false, error: 'Payment amount mismatch' };
  }

  if (pay.currency !== input.expectedCurrency) {
    return { ok: false, error: 'Payment currency mismatch' };
  }

  const paymentStatus = String(pay.status ?? '').toLowerCase();
  if (paymentStatus === 'authorized') {
    return { ok: false, error: 'Payment is authorized but not captured' };
  }
  if (paymentStatus !== 'captured') {
    return { ok: false, error: 'Payment is not captured' };
  }

  return { ok: true };
}
