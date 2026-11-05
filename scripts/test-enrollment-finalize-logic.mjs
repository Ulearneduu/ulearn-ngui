/**
 * Contract tests for enrollment finalize behavior (mirrors SQL transaction rules).
 * Usage: node scripts/test-enrollment-finalize-logic.mjs
 */

function migrationBlockedWhenDuplicateEnrollments(duplicateGroupCount) {
  return duplicateGroupCount > 0;
}

function applyCouponDiscountRupees(baseRupees, discountPercent) {
  if (!Number.isFinite(baseRupees) || baseRupees <= 0) return 0;
  if (!Number.isFinite(discountPercent) || discountPercent <= 0) {
    return Math.round(baseRupees);
  }
  const pct = Math.min(100, Math.max(0, discountPercent));
  return Math.max(0, Math.round(baseRupees * (1 - pct / 100)));
}

/** Simplified paid-finalize state machine (no broad unique_violation → success). */
function simulatePaidFinalize(state, action) {
  const s = { ...state };

  if (action.type === 'check_payment_id_conflict') {
    if (s.paymentIdOwnerOrderId && s.paymentIdOwnerOrderId !== s.orderId) {
      return { error: 'Payment id already used', state: s, success: false };
    }
    return { state: s, success: true };
  }

  if (action.type === 'replay_paid_order') {
    if (s.orderStatus !== 'paid') return { error: 'not paid', state: s, success: false };
    if (!s.enrolled) return { error: 'paid without enrollment', state: s, success: false };
    if (s.recordedPaymentId && s.recordedPaymentId !== action.paymentId) {
      return { error: 'payment id mismatch', state: s, success: false };
    }
    return { state: s, success: true, alreadyEnrolled: true };
  }

  if (action.type === 'idempotent_existing_enrollment') {
    if (action.productType === 'course') {
      return {
        error: 'ambiguous course payment replay',
        state: s,
        success: false
      };
    }
    if (!s.enrolled) return { error: 'no enrollment', state: s, success: false };
    if (s.enrolledUserId !== action.userId || s.enrolledProductId !== action.productId) {
      return { error: 'wrong user or product', state: s, success: false };
    }
    if (s.orderStatus === 'pending') {
      if (action.markPaidFails) {
        return { error: 'Could not mark payment order as paid during idempotent replay', state: s, success: false };
      }
      s.orderStatus = 'paid';
      s.recordedPaymentId = action.paymentId;
    }
    return { state: s, success: true, alreadyEnrolled: true };
  }

  if (action.type === 'insert_enrollment') {
    if (s.enrolled) return { error: 'unique_violation', state: s, success: false };
    if (action.failInsert) return { error: 'insert_failed', state: s, success: false };
    s.enrolled = true;
    s.enrolledUserId = action.userId;
    s.enrolledProductId = action.productId;
    return { state: s, success: true };
  }

  if (action.type === 'increment_coupon') {
    if (!s.enrolled) return { error: 'no enrollment for coupon', state: s, success: false };
    if (s.couponUsed >= s.maxCouponUses) {
      s.enrolled = false;
      s.enrolledUserId = null;
      s.enrolledProductId = null;
      return { error: 'coupon_failed', state: s, success: false };
    }
    s.couponUsed += 1;
    return { state: s, success: true };
  }

  if (action.type === 'mark_paid') {
    if (!s.enrolled) return { error: 'cannot mark paid without enrollment', state: s, success: false };
    s.orderStatus = 'paid';
    s.recordedPaymentId = action.paymentId;
    return { state: s, success: true };
  }

  if (action.type === 'unrelated_unique_violation') {
    return { error: 'unique_violation', state: s, success: false };
  }

  return { error: 'unknown', state: s, success: false };
}

function runPaidHappyPath(state) {
  let s = state;
  let r = simulatePaidFinalize(s, { type: 'check_payment_id_conflict' });
  if (!r.success) return r;
  s = r.state;
  r = simulatePaidFinalize(s, {
    type: 'insert_enrollment',
    userId: 'u1',
    productId: 'c1'
  });
  if (!r.success) return r;
  s = r.state;
  r = simulatePaidFinalize(s, { type: 'increment_coupon' });
  if (!r.success) return r;
  s = r.state;
  return simulatePaidFinalize(s, { type: 'mark_paid', paymentId: 'pay_1' });
}

const tests = [
  [
    'migration blocked on duplicate enrollment groups',
    () => migrationBlockedWhenDuplicateEnrollments(3) === true
  ],
  [
    'migration allowed when no duplicate enrollment groups',
    () => migrationBlockedWhenDuplicateEnrollments(0) === false
  ],
  [
    'duplicate enrollment replay via explicit idempotent path',
    () => {
      const base = {
        orderId: 'ord_1',
        orderStatus: 'pending',
        enrolled: true,
        enrolledUserId: 'u1',
        enrolledProductId: 'c1',
        couponUsed: 1,
        maxCouponUses: 1,
        recordedPaymentId: null
      };
      const r = simulatePaidFinalize(base, {
        type: 'idempotent_existing_enrollment',
        productType: 'internship',
        userId: 'u1',
        productId: 'c1',
        paymentId: 'pay_1'
      });
      return r.success && r.alreadyEnrolled && r.state.orderStatus === 'paid';
    }
  ],
  [
    'duplicate Razorpay payment ID belonging to another order is rejected',
    () => {
      const r = simulatePaidFinalize(
        { orderId: 'ord_2', paymentIdOwnerOrderId: 'ord_1' },
        { type: 'check_payment_id_conflict' }
      );
      return !r.success && r.error === 'Payment id already used';
    }
  ],
  [
    'unrelated unique constraint violation does not return success',
    () => {
      const r = simulatePaidFinalize({ enrolled: false }, { type: 'unrelated_unique_violation' });
      return !r.success && r.error === 'unique_violation';
    }
  ],
  [
    'failed enrollment insert does not mark order paid',
    () => {
      const r = simulatePaidFinalize(
        { orderStatus: 'pending', enrolled: false },
        { type: 'insert_enrollment', userId: 'u1', productId: 'c1', failInsert: true }
      );
      return !r.success && r.error === 'insert_failed';
    }
  ],
  [
    'coupon failure rolls back enrollment before mark paid',
    () => {
      let s = {
        orderStatus: 'pending',
        enrolled: false,
        couponUsed: 0,
        maxCouponUses: 0
      };
      let r = simulatePaidFinalize(s, {
        type: 'insert_enrollment',
        userId: 'u1',
        productId: 'c1'
      });
      s = r.state;
      r = simulatePaidFinalize(s, { type: 'increment_coupon' });
      const mark = simulatePaidFinalize(r.state, { type: 'mark_paid', paymentId: 'pay_1' });
      return !r.success && !r.state.enrolled && !mark.success;
    }
  ],
  [
    'legitimate payment verification replay when order already paid',
    () => {
      const r = simulatePaidFinalize(
        {
          orderStatus: 'paid',
          enrolled: true,
          recordedPaymentId: 'pay_1'
        },
        { type: 'replay_paid_order', paymentId: 'pay_1' }
      );
      return r.success && r.alreadyEnrolled;
    }
  ],
  [
    'paid order without enrollment record is rejected',
    () => {
      const r = simulatePaidFinalize(
        { orderStatus: 'paid', enrolled: false },
        { type: 'replay_paid_order', paymentId: 'pay_1' }
      );
      return !r.success && r.error === 'paid without enrollment';
    }
  ],
  [
    'concurrent insert unique violation surfaces as error not success',
    () => {
      const r = simulatePaidFinalize(
        { enrolled: true, enrolledUserId: 'u1', enrolledProductId: 'c1' },
        { type: 'insert_enrollment', userId: 'u1', productId: 'c1' }
      );
      return !r.success && r.error === 'unique_violation';
    }
  ],
  [
    'course pending replay with existing enrollment is rejected',
    () => {
      const r = simulatePaidFinalize(
        {
          orderStatus: 'pending',
          enrolled: true,
          enrolledUserId: 'u1',
          enrolledProductId: 'c1'
        },
        {
          type: 'idempotent_existing_enrollment',
          productType: 'course',
          userId: 'u1',
          productId: 'c1',
          paymentId: 'pay_1'
        }
      );
      return !r.success && r.error === 'ambiguous course payment replay';
    }
  ],
  [
    'idempotent pending update failure raises instead of success',
    () => {
      const r = simulatePaidFinalize(
        {
          orderStatus: 'pending',
          enrolled: true,
          enrolledUserId: 'u1',
          enrolledProductId: 'i1'
        },
        {
          type: 'idempotent_existing_enrollment',
          productType: 'internship',
          userId: 'u1',
          productId: 'i1',
          paymentId: 'pay_1',
          markPaidFails: true
        }
      );
      return !r.success && r.error.includes('Could not mark payment order as paid');
    }
  ],
  [
    'free enrollment with 100 percent coupon',
    () => applyCouponDiscountRupees(1500, 100) === 0
  ],
  [
    'course and internship free final amount compatibility',
    () =>
      applyCouponDiscountRupees(0, 0) === 0 &&
      applyCouponDiscountRupees(999, 10) === 899
  ]
];

let failed = 0;
for (const [name, fn] of tests) {
  if (!fn()) {
    console.error('FAIL:', name);
    failed++;
  } else {
    console.log('PASS:', name);
  }
}

if (failed > 0) process.exit(1);
console.log(`All ${tests.length} tests passed.`);
