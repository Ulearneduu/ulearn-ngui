-- Run manually BEFORE applying 20261104_secure_enrollment_payment.sql
-- Resolve any rows reported below before migrating (do not auto-delete).

-- 1) Duplicate course enrollments (blocks enrollments_user_course_unique)
SELECT user_id, course_id, COUNT(*) AS enrollment_count
FROM public.enrollments
GROUP BY user_id, course_id
HAVING COUNT(*) > 1
ORDER BY enrollment_count DESC;

-- 2) Duplicate non-null Razorpay payment IDs on internship applications
SELECT razorpay_payment_id, COUNT(*) AS row_count
FROM public.internship_applications
WHERE razorpay_payment_id IS NOT NULL
GROUP BY razorpay_payment_id
HAVING COUNT(*) > 1;

-- 3) Duplicate non-null Razorpay order IDs on internship applications
SELECT razorpay_order_id, COUNT(*) AS row_count
FROM public.internship_applications
WHERE razorpay_order_id IS NOT NULL
GROUP BY razorpay_order_id
HAVING COUNT(*) > 1;
