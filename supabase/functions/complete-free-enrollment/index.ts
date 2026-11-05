import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import {
  applyCouponDiscountRupees,
  corsHeaders,
  courseEnrollmentDetailsToJson,
  createAdminClient,
  fetchProductPrice,
  internshipEnrollmentDetailsToJson,
  json,
  parseExclusiveProductId,
  parseFinalizeRpcResult,
  requireAuthenticatedUser,
  validateCouponServer,
  validateCourseEnrollmentDetails,
  validateInternshipEnrollmentDetails
} from '../_shared/enrollment-payment.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const auth = await requireAuthenticatedUser(req);
    if (!auth.ok) return auth.response;

    const body = await req.json();
    const product = parseExclusiveProductId(body);
    if (!product.ok) {
      return json({ error: product.error }, 400);
    }

    const adminClient = createAdminClient();
    const priceResult = await fetchProductPrice(adminClient, product.kind, product.id);
    if (!priceResult.ok) {
      return json({ error: priceResult.error }, priceResult.status);
    }

    const couponCode =
      typeof body.couponCode === 'string' ? body.couponCode.trim() : undefined;
    const coupon = await validateCouponServer(adminClient, couponCode);
    if (couponCode && !coupon.valid) {
      return json({ error: coupon.message || 'Invalid coupon' }, 400);
    }

    const finalRupees = applyCouponDiscountRupees(
      priceResult.baseRupees,
      coupon.valid ? coupon.discountPercent : 0
    );

    if (finalRupees > 0) {
      return json({ error: 'This product requires payment' }, 400);
    }

    let detailsJson: Record<string, string | number>;
    let rpcArgs: Record<string, unknown>;

    if (product.kind === 'internship') {
      const detailsCheck = validateInternshipEnrollmentDetails(body.internshipEnrollmentDetails);
      if (!detailsCheck.ok) {
        return json({ error: detailsCheck.error }, 400);
      }
      detailsJson = internshipEnrollmentDetailsToJson(detailsCheck.value);
      rpcArgs = {
        p_user_id: auth.userId,
        p_product_type: 'internship',
        p_course_id: null,
        p_internship_id: product.id,
        p_coupon_code: couponCode ?? null,
        p_details: detailsJson
      };
    } else {
      const detailsCheck = validateCourseEnrollmentDetails(body.enrollmentDetails);
      if (!detailsCheck.ok) {
        return json({ error: detailsCheck.error }, 400);
      }
      detailsJson = courseEnrollmentDetailsToJson(detailsCheck.value);
      rpcArgs = {
        p_user_id: auth.userId,
        p_product_type: 'course',
        p_course_id: product.id,
        p_internship_id: null,
        p_coupon_code: couponCode ?? null,
        p_details: detailsJson
      };
    }

    const { data: finalizeData, error: finalizeErr } = await adminClient.rpc(
      'finalize_free_enrollment',
      rpcArgs
    );

    if (finalizeErr) {
      return json({ error: finalizeErr.message }, 400);
    }

    const result = parseFinalizeRpcResult(finalizeData);
    if (!result.success) {
      return json({ error: result.error || 'Enrollment failed' }, 400);
    }

    return json({
      success: true,
      ...(result.alreadyEnrolled ? { alreadyEnrolled: true } : {})
    });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
