/**
 * Node runnable tests for enrollment pricing helpers (mirrors enrollment-payment.ts).
 * Usage: node scripts/test-enrollment-payment-logic.mjs
 */

function parseExclusiveProductId(body) {
  const courseId = typeof body.courseId === 'string' ? body.courseId.trim() : '';
  const internshipId = typeof body.internshipId === 'string' ? body.internshipId.trim() : '';
  const hasCourse = courseId.length > 0;
  const hasInternship = internshipId.length > 0;
  if (hasCourse && hasInternship) return { ok: false };
  if (!hasCourse && !hasInternship) return { ok: false };
  if (hasCourse) return { ok: true, kind: 'course', id: courseId };
  return { ok: true, kind: 'internship', id: internshipId };
}

function rupeesToPaise(rupees) {
  if (!Number.isFinite(rupees) || rupees < 0) return 0;
  return Math.max(0, Math.round(rupees * 100));
}

function applyCouponDiscountRupees(baseRupees, discountPercent) {
  if (!Number.isFinite(baseRupees) || baseRupees <= 0) return 0;
  if (!Number.isFinite(discountPercent) || discountPercent <= 0) {
    return Math.round(baseRupees);
  }
  const pct = Math.min(100, Math.max(0, discountPercent));
  return Math.max(0, Math.round(baseRupees * (1 - pct / 100)));
}

const tests = [
  ['paid internship no coupon', () => applyCouponDiscountRupees(2000, 0) === 2000],
  ['valid coupon 20%', () => applyCouponDiscountRupees(2000, 20) === 1600],
  ['never negative', () => applyCouponDiscountRupees(100, 150) === 0],
  ['free internship', () => applyCouponDiscountRupees(0, 0) === 0],
  ['manipulated zero vs server', () => applyCouponDiscountRupees(2000, 0) !== 0],
  ['client amount tamper', () => rupeesToPaise(applyCouponDiscountRupees(2500, 10)) === 225000],
  ['both ids rejected', () => !parseExclusiveProductId({ courseId: 'a', internshipId: 'b' }).ok],
  ['neither id rejected', () => !parseExclusiveProductId({}).ok],
  ['course regression rounding', () => applyCouponDiscountRupees(999, 5) === 949]
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

if (failed > 0) {
  process.exit(1);
}
console.log(`All ${tests.length} tests passed.`);
