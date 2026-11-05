/**
 * Tests production validators from enrollment-payment-validation.mjs
 * Usage: node scripts/test-razorpay-payment-verify.mjs
 */

import {
  normalizeVerifyPaymentStrings,
  validatePaymentOrderProductMatch,
  validatePaymentOrderStatusForVerify,
  validateRazorpayOrderForFinalize,
  validateRazorpayPaymentForFinalize,
  validateVerifyRequestProductIds
} from '../supabase/functions/_shared/enrollment-payment-validation.mjs';

const base = {
  submittedPaymentId: 'pay_abc',
  submittedOrderId: 'order_xyz',
  expectedAmountPaise: 160000,
  expectedCurrency: 'INR'
};

const courseOrder = {
  product_type: 'course',
  course_id: 'course-1',
  internship_id: null,
  status: 'pending'
};

const internOrder = {
  product_type: 'internship',
  course_id: null,
  internship_id: 'intern-1',
  status: 'paid'
};

const tests = [
  [
    'whitespace-only payment strings rejected before signature',
    () => {
      const r = normalizeVerifyPaymentStrings({
        razorpay_order_id: '   ',
        razorpay_payment_id: 'pay_abc',
        razorpay_signature: 'sig'
      });
      return !r.ok && r.error === 'Missing payment details';
    }
  ],
  [
    'Razorpay order id mismatch',
    () => {
      const r = validateRazorpayOrderForFinalize({
        apiOk: true,
        order: { id: 'order_other', amount: 160000, currency: 'INR' },
        submittedOrderId: 'order_xyz',
        expectedAmountPaise: 160000,
        expectedCurrency: 'INR'
      });
      return !r.ok && r.error === 'Razorpay order id mismatch';
    }
  ],
  [
    'Razorpay order API failure',
    () => {
      const r = validateRazorpayOrderForFinalize({
        apiOk: false,
        order: null,
        submittedOrderId: 'order_xyz',
        expectedAmountPaise: 160000,
        expectedCurrency: 'INR'
      });
      return !r.ok && r.error === 'Could not verify Razorpay order';
    }
  ],
  [
    'captured payment with correct details',
    () => {
      const r = validateRazorpayPaymentForFinalize({
        apiOk: true,
        payment: {
          id: 'pay_abc',
          order_id: 'order_xyz',
          amount: 160000,
          currency: 'INR',
          status: 'captured'
        },
        ...base
      });
      return r.ok === true;
    }
  ],
  [
    'authorized but not captured payment',
    () => {
      const r = validateRazorpayPaymentForFinalize({
        apiOk: true,
        payment: {
          id: 'pay_abc',
          order_id: 'order_xyz',
          amount: 160000,
          currency: 'INR',
          status: 'authorized'
        },
        ...base
      });
      return !r.ok && r.error === 'Payment is authorized but not captured';
    }
  ],
  [
    'payment belonging to a different order',
    () => {
      const r = validateRazorpayPaymentForFinalize({
        apiOk: true,
        payment: {
          id: 'pay_abc',
          order_id: 'order_other',
          amount: 160000,
          currency: 'INR',
          status: 'captured'
        },
        ...base
      });
      return !r.ok && r.error === 'Payment belongs to a different order';
    }
  ],
  [
    'amount mismatch',
    () => {
      const r = validateRazorpayPaymentForFinalize({
        apiOk: true,
        payment: {
          id: 'pay_abc',
          order_id: 'order_xyz',
          amount: 100,
          currency: 'INR',
          status: 'captured'
        },
        ...base
      });
      return !r.ok && r.error === 'Payment amount mismatch';
    }
  ],
  [
    'currency mismatch',
    () => {
      const r = validateRazorpayPaymentForFinalize({
        apiOk: true,
        payment: {
          id: 'pay_abc',
          order_id: 'order_xyz',
          amount: 160000,
          currency: 'USD',
          status: 'captured'
        },
        ...base
      });
      return !r.ok && r.error === 'Payment currency mismatch';
    }
  ],
  [
    'invalid payment ID',
    () => {
      const r = validateRazorpayPaymentForFinalize({
        apiOk: false,
        payment: { error: { description: 'The id provided does not exist' } },
        ...base
      });
      return !r.ok && r.error.includes('Could not verify Razorpay payment');
    }
  ],
  [
    'Razorpay API failure',
    () => {
      const r = validateRazorpayPaymentForFinalize({
        apiOk: false,
        payment: null,
        ...base
      });
      return !r.ok && r.error === 'Could not verify Razorpay payment';
    }
  ],
  [
    'captured payment passes validator (DB replay is handled by finalize_paid_enrollment RPC)',
    () => {
      const r = validateRazorpayPaymentForFinalize({
        apiOk: true,
        payment: {
          id: 'pay_abc',
          order_id: 'order_xyz',
          amount: 160000,
          currency: 'INR',
          status: 'captured'
        },
        ...base
      });
      return r.ok === true;
    }
  ],
  [
    'both product IDs supplied',
    () => {
      const r = validateVerifyRequestProductIds({ courseId: 'c1', internshipId: 'i1' });
      return !r.ok && r.error.includes('not both');
    }
  ],
  [
    'missing product ID',
    () => {
      const r = validateVerifyRequestProductIds({});
      return !r.ok && r.error === 'courseId or internshipId is required';
    }
  ],
  [
    'course ID with internship payment order',
    () => {
      const r = validatePaymentOrderProductMatch(internOrder, { courseId: 'course-1' });
      return !r.ok && r.error === 'Payment order is not a course order';
    }
  ],
  [
    'internship ID with course payment order',
    () => {
      const r = validatePaymentOrderProductMatch(courseOrder, { internshipId: 'intern-1' });
      return !r.ok && r.error === 'Payment order is not an internship order';
    }
  ],
  [
    'payment order pending status allowed',
    () => validatePaymentOrderStatusForVerify('pending').ok === true
  ],
  [
    'payment order paid status allowed for replay',
    () => validatePaymentOrderStatusForVerify('paid').ok === true
  ],
  [
    'payment order failed status rejected',
    () => {
      const r = validatePaymentOrderStatusForVerify('failed');
      return !r.ok && r.error === 'Payment order has failed';
    }
  ],
  [
    'payment order expired status rejected',
    () => {
      const r = validatePaymentOrderStatusForVerify('expired');
      return !r.ok && r.error === 'Payment order has expired';
    }
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
