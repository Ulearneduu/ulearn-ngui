import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import {
  corsHeaders,
  courseEnrollmentDetailsToJson,
  createAdminClient,
  internshipEnrollmentDetailsToJson,
  json,
  normalizeVerifyPaymentStrings,
  parseFinalizeRpcResult,
  requireAuthenticatedUser,
  validateCourseEnrollmentDetails,
  validateInternshipEnrollmentDetails,
  validatePaymentOrderProductMatch,
  validatePaymentOrderStatusForVerify,
  validateRazorpayOrderForFinalize,
  validateRazorpayPaymentForFinalize,
  validateVerifyRequestProductIds,
  verifyRazorpaySignature
} from '../_shared/enrollment-payment.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const keyId = Deno.env.get('RAZORPAY_KEY_ID');
    const keySecret = Deno.env.get('RAZORPAY_KEY_SECRET');
    if (!keyId || !keySecret) {
      return json({ error: 'Razorpay keys not configured' }, 500);
    }

    const auth = await requireAuthenticatedUser(req);
    if (!auth.ok) return auth.response;

    const body = await req.json();
    const {
      courseId,
      internshipId,
      razorpay_order_id: rawOrderId,
      razorpay_payment_id: rawPaymentId,
      razorpay_signature: rawSignature,
      enrollmentDetails,
      internshipEnrollmentDetails
    } = body;

    const paymentStrings = normalizeVerifyPaymentStrings({
      razorpay_order_id: rawOrderId,
      razorpay_payment_id: rawPaymentId,
      razorpay_signature: rawSignature
    });
    if (!paymentStrings.ok) {
      return json({ error: paymentStrings.error }, 400);
    }

    const razorpay_order_id = paymentStrings.razorpay_order_id;
    const razorpay_payment_id = paymentStrings.razorpay_payment_id;
    const razorpay_signature = paymentStrings.razorpay_signature;

    const productIds = validateVerifyRequestProductIds({ courseId, internshipId });
    if (!productIds.ok) {
      return json({ error: productIds.error }, 400);
    }

    const signatureOk = await verifyRazorpaySignature(
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      keySecret
    );
    if (!signatureOk) {
      return json({ error: 'Invalid payment signature' }, 400);
    }

    const adminClient = createAdminClient();
    const authHeader = `Basic ${btoa(`${keyId}:${keySecret}`)}`;

    const { data: paymentOrder, error: orderErr } = await adminClient
      .from('payment_orders')
      .select('id, user_id, amount_paise, currency, product_type, course_id, internship_id, status')
      .eq('razorpay_order_id', razorpay_order_id)
      .maybeSingle();

    if (orderErr || !paymentOrder) {
      return json({ error: 'Payment order not found' }, 404);
    }

    if (paymentOrder.user_id !== auth.userId) {
      return json({ error: 'Payment order does not belong to this user' }, 403);
    }

    const productMatch = validatePaymentOrderProductMatch(paymentOrder, {
      courseId: productIds.courseId,
      internshipId: productIds.internshipId
    });
    if (!productMatch.ok) {
      return json({ error: productMatch.error }, 400);
    }

    const orderStatusCheck = validatePaymentOrderStatusForVerify(paymentOrder.status);
    if (!orderStatusCheck.ok) {
      return json({ error: orderStatusCheck.error }, 400);
    }

    const encodedOrderId = encodeURIComponent(String(razorpay_order_id));
    const rzOrderRes = await fetch(`https://api.razorpay.com/v1/orders/${encodedOrderId}`, {
      headers: { Authorization: authHeader }
    });
    const rzOrder = await rzOrderRes.json();

    const orderCheck = validateRazorpayOrderForFinalize({
      apiOk: rzOrderRes.ok,
      order: rzOrder,
      submittedOrderId: razorpay_order_id,
      expectedAmountPaise: paymentOrder.amount_paise,
      expectedCurrency: paymentOrder.currency
    });
    if (!orderCheck.ok) {
      return json({ error: orderCheck.error }, 400);
    }

    const encodedPaymentId = encodeURIComponent(String(razorpay_payment_id));
    const rzPayRes = await fetch(`https://api.razorpay.com/v1/payments/${encodedPaymentId}`, {
      headers: { Authorization: authHeader }
    });
    const rzPayment = await rzPayRes.json();

    const paymentCheck = validateRazorpayPaymentForFinalize({
      apiOk: rzPayRes.ok,
      payment: rzPayment,
      submittedPaymentId: razorpay_payment_id,
      submittedOrderId: razorpay_order_id,
      expectedAmountPaise: paymentOrder.amount_paise,
      expectedCurrency: paymentOrder.currency
    });

    if (!paymentCheck.ok) {
      return json({ error: paymentCheck.error }, 400);
    }

    let detailsJson: Record<string, string | number>;
    if (paymentOrder.product_type === 'internship') {
      const detailsCheck = validateInternshipEnrollmentDetails(internshipEnrollmentDetails);
      if (!detailsCheck.ok) {
        return json({ error: detailsCheck.error }, 400);
      }
      detailsJson = internshipEnrollmentDetailsToJson(detailsCheck.value);
    } else {
      const detailsCheck = validateCourseEnrollmentDetails(enrollmentDetails);
      if (!detailsCheck.ok) {
        return json({ error: detailsCheck.error }, 400);
      }
      detailsJson = courseEnrollmentDetailsToJson(detailsCheck.value);
    }

    const { data: finalizeData, error: finalizeErr } = await adminClient.rpc(
      'finalize_paid_enrollment',
      {
        p_user_id: auth.userId,
        p_razorpay_order_id: razorpay_order_id,
        p_razorpay_payment_id: razorpay_payment_id,
        p_details: detailsJson
      }
    );

    if (finalizeErr) {
      return json({ error: finalizeErr.message }, 400);
    }

    const result = parseFinalizeRpcResult(finalizeData);
    if (!result.success) {
      return json({ error: result.error || 'Payment verification failed' }, 400);
    }

    return json({
      success: true,
      ...(result.alreadyEnrolled ? { alreadyEnrolled: true } : {})
    });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
