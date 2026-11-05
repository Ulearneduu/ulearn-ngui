import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import {
  applyCouponDiscountRupees,
  corsHeaders,
  createAdminClient,
  fetchProductPrice,
  json,
  parseExclusiveProductId,
  requireAuthenticatedUser,
  rupeesToPaise,
  validateCouponServer
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
    const product = parseExclusiveProductId(body);
    if (!product.ok) {
      return json({ error: product.error }, 400);
    }

    if (body.amount != null) {
      // Client-sent amounts are ignored; log-style rejection prevents confusion
      return json({ error: 'Amount must not be sent by the client' }, 400);
    }

    const adminClient = createAdminClient();
    const priceResult = await fetchProductPrice(adminClient, product.kind, product.id);
    if (!priceResult.ok) {
      return json({ error: priceResult.error }, priceResult.status);
    }

    if (priceResult.baseRupees <= 0) {
      return json({ error: 'This product is free; use free enrollment instead of payment' }, 400);
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
    const amountPaise = rupeesToPaise(finalRupees);
    if (amountPaise < 100) {
      return json({ error: 'Payable amount is below minimum charge' }, 400);
    }

    const { data: existingEnrollment } =
      product.kind === 'course'
        ? await adminClient
            .from('enrollments')
            .select('id')
            .eq('user_id', auth.userId)
            .eq('course_id', product.id)
            .maybeSingle()
        : await adminClient
            .from('internship_applications')
            .select('id')
            .eq('user_id', auth.userId)
            .eq('internship_id', product.id)
            .maybeSingle();

    if (existingEnrollment) {
      return json({ error: 'Already enrolled or applied' }, 409);
    }

    const basePaise = rupeesToPaise(priceResult.baseRupees);
    const insertRow: Record<string, unknown> = {
      user_id: auth.userId,
      product_type: product.kind,
      base_amount_paise: basePaise,
      amount_paise: amountPaise,
      currency: 'INR',
      status: 'pending',
      coupon_code: coupon.valid ? couponCode : null,
      discount_percent: coupon.valid ? coupon.discountPercent : null
    };
    if (product.kind === 'course') {
      insertRow.course_id = product.id;
    } else {
      insertRow.internship_id = product.id;
    }

    const { data: paymentOrder, error: orderInsertErr } = await adminClient
      .from('payment_orders')
      .insert(insertRow)
      .select('id')
      .single();

    if (orderInsertErr || !paymentOrder) {
      return json({ error: orderInsertErr?.message || 'Could not create payment record' }, 500);
    }

    const receiptPrefix = product.kind === 'internship' ? 'intern' : 'course';
    const receipt = `${receiptPrefix}_${String(product.id).slice(0, 8)}_${Date.now()}`;

    const orderRes = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + btoa(`${keyId}:${keySecret}`),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        amount: amountPaise,
        currency: 'INR',
        receipt,
        notes: {
          user_id: auth.userId,
          payment_order_id: paymentOrder.id,
          product_type: product.kind,
          ...(product.kind === 'course'
            ? { course_id: product.id }
            : { internship_id: product.id })
        }
      })
    });

    const order = await orderRes.json();
    if (!orderRes.ok) {
      await adminClient
        .from('payment_orders')
        .update({ status: 'failed' })
        .eq('id', paymentOrder.id);
      return json({ error: order.error?.description || 'Order creation failed' }, 400);
    }

    const { error: linkErr } = await adminClient
      .from('payment_orders')
      .update({ razorpay_order_id: order.id })
      .eq('id', paymentOrder.id);

    if (linkErr) {
      return json({ error: 'Could not link Razorpay order' }, 500);
    }

    return json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency
    });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
