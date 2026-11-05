-- Transactional enrollment finalization (paid + free). Requires 20261104 applied first.

-- ─── Paid: single transaction (order lock → enroll → coupon → mark paid) ───────

CREATE OR REPLACE FUNCTION public.finalize_paid_enrollment(
  p_user_id uuid,
  p_razorpay_order_id text,
  p_razorpay_payment_id text,
  p_details jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.payment_orders%ROWTYPE;
  v_amount_paid numeric(12,2);
  v_coupon_ok boolean;
  v_has_enrollment boolean;
BEGIN
  IF p_user_id IS NULL OR p_razorpay_order_id IS NULL OR p_razorpay_payment_id IS NULL THEN
    RAISE EXCEPTION 'Missing required payment finalize parameters';
  END IF;

  IF p_details IS NULL OR p_details = '{}'::jsonb THEN
    RAISE EXCEPTION 'Enrollment details are required';
  END IF;

  SELECT * INTO v_order
  FROM public.payment_orders
  WHERE razorpay_order_id = p_razorpay_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment order not found';
  END IF;

  IF v_order.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'Payment order does not belong to this user';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.payment_orders
    WHERE razorpay_payment_id = p_razorpay_payment_id
      AND id IS DISTINCT FROM v_order.id
  ) THEN
    RAISE EXCEPTION 'Payment id already used';
  END IF;

  IF v_order.product_type = 'internship' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.internship_applications a
      WHERE a.user_id = p_user_id
        AND a.internship_id = v_order.internship_id
    ) INTO v_has_enrollment;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM public.enrollments e
      WHERE e.user_id = p_user_id
        AND e.course_id = v_order.course_id
    ) INTO v_has_enrollment;
  END IF;

  IF v_order.status = 'paid' THEN
    IF NOT v_has_enrollment THEN
      RAISE EXCEPTION 'Payment order is paid but enrollment record is missing';
    END IF;
    IF v_order.razorpay_payment_id IS NOT NULL
       AND v_order.razorpay_payment_id IS DISTINCT FROM p_razorpay_payment_id THEN
      RAISE EXCEPTION 'Payment id does not match this order';
    END IF;
    RETURN jsonb_build_object('success', true, 'already_enrolled', true);
  END IF;

  IF v_order.status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'Payment order is not payable';
  END IF;

  IF v_has_enrollment THEN
    IF v_order.product_type = 'internship' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.internship_applications a
        WHERE a.user_id = p_user_id
          AND a.internship_id = v_order.internship_id
          AND (a.razorpay_order_id IS NULL OR a.razorpay_order_id = p_razorpay_order_id)
          AND (a.razorpay_payment_id IS NULL OR a.razorpay_payment_id = p_razorpay_payment_id)
      ) THEN
        RAISE EXCEPTION 'Existing application does not match this payment';
      END IF;

      UPDATE public.payment_orders
      SET status = 'paid',
          razorpay_payment_id = p_razorpay_payment_id,
          paid_at = now()
      WHERE id = v_order.id
        AND status = 'pending';

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Could not mark payment order as paid during idempotent replay';
      END IF;

      RETURN jsonb_build_object('success', true, 'already_enrolled', true);
    END IF;

    -- Course enrollments do not store Razorpay order/payment ids. A pending payment order
    -- cannot be safely tied to a pre-existing enrollment (free, admin, or other payment).
    RAISE EXCEPTION
      'Existing course enrollment cannot be linked to this payment; retry is not supported without enrollment payment metadata';
  END IF;

  v_amount_paid := (v_order.amount_paise::numeric / 100);

  IF v_order.product_type = 'internship' THEN
    INSERT INTO public.internship_applications (
      user_id, internship_id, status,
      full_name, phone, email, college_name, degree, graduation_year, specialization,
      amount_paid, razorpay_order_id, razorpay_payment_id,
      coupon_code_used, coupon_discount_percent
    ) VALUES (
      p_user_id,
      v_order.internship_id,
      'applied',
      NULLIF(trim(p_details->>'full_name'), ''),
      NULLIF(trim(p_details->>'phone'), ''),
      NULLIF(trim(p_details->>'email'), ''),
      NULLIF(trim(p_details->>'college_name'), ''),
      NULLIF(trim(p_details->>'degree'), ''),
      NULLIF(trim(p_details->>'graduation_year'), '')::integer,
      NULLIF(trim(p_details->>'specialization'), ''),
      v_amount_paid,
      p_razorpay_order_id,
      p_razorpay_payment_id,
      v_order.coupon_code,
      v_order.discount_percent
    );
  ELSE
    INSERT INTO public.enrollments (
      user_id, course_id,
      full_name, phone, email, college_name, degree, degree_year, specialization,
      live_class_start_month, amount_paid,
      coupon_code_used, coupon_discount_percent
    ) VALUES (
      p_user_id,
      v_order.course_id,
      NULLIF(trim(p_details->>'full_name'), ''),
      NULLIF(trim(p_details->>'phone'), ''),
      NULLIF(trim(p_details->>'email'), ''),
      NULLIF(trim(p_details->>'college_name'), ''),
      NULLIF(trim(p_details->>'degree'), ''),
      NULLIF(trim(p_details->>'degree_year'), '')::integer,
      NULLIF(trim(p_details->>'specialization'), ''),
      NULLIF(trim(p_details->>'live_class_start_month'), ''),
      v_amount_paid,
      v_order.coupon_code,
      v_order.discount_percent
    );
  END IF;

  IF v_order.coupon_code IS NOT NULL AND trim(v_order.coupon_code) <> '' THEN
    v_coupon_ok := public.try_increment_coupon_usage(v_order.coupon_code);
    IF NOT v_coupon_ok THEN
      RAISE EXCEPTION 'Coupon usage limit reached or coupon no longer valid';
    END IF;
  END IF;

  UPDATE public.payment_orders
  SET status = 'paid',
      razorpay_payment_id = p_razorpay_payment_id,
      paid_at = now()
  WHERE id = v_order.id
    AND status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not mark payment order as paid';
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$$;

-- ─── Free / 100% discount: validate product + coupon in DB, one transaction ───
-- Concurrent free enroll: two requests may both pass the EXISTS pre-check; the second
-- INSERT hits (user_id, course_id) or (internship_id, user_id) uniqueness and the whole
-- transaction rolls back. The client should retry; the retry then returns already_enrolled.
-- Unrelated unique_violation errors are not converted to success (no exception handler).

CREATE OR REPLACE FUNCTION public.finalize_free_enrollment(
  p_user_id uuid,
  p_product_type text,
  p_course_id uuid,
  p_internship_id uuid,
  p_coupon_code text,
  p_details jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base numeric(12,2);
  v_discount numeric(5,2) := 0;
  v_final numeric(12,2);
  v_coupon_result jsonb;
  v_coupon_ok boolean;
  v_normalized_coupon text;
BEGIN
  IF p_user_id IS NULL OR p_details IS NULL OR p_details = '{}'::jsonb THEN
    RAISE EXCEPTION 'Missing required free enrollment parameters';
  END IF;

  IF p_product_type = 'course' THEN
    IF p_course_id IS NULL OR p_internship_id IS NOT NULL THEN
      RAISE EXCEPTION 'Invalid course product identifier';
    END IF;

    SELECT coalesce(c.price, 0)::numeric(12,2) INTO v_base
    FROM public.courses c
    WHERE c.id = p_course_id AND c.status = 'published';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Course not found or not published';
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.enrollments e
      WHERE e.user_id = p_user_id AND e.course_id = p_course_id
    ) THEN
      RETURN jsonb_build_object('success', true, 'already_enrolled', true);
    END IF;
  ELSIF p_product_type = 'internship' THEN
    IF p_internship_id IS NULL OR p_course_id IS NOT NULL THEN
      RAISE EXCEPTION 'Invalid internship product identifier';
    END IF;

    SELECT coalesce(i.price, 0)::numeric(12,2) INTO v_base
    FROM public.internships i
    WHERE i.id = p_internship_id AND i.status = 'open';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Internship not found or not open';
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.internship_applications a
      WHERE a.user_id = p_user_id AND a.internship_id = p_internship_id
    ) THEN
      RETURN jsonb_build_object('success', true, 'already_enrolled', true);
    END IF;
  ELSE
    RAISE EXCEPTION 'Invalid product type';
  END IF;

  v_normalized_coupon := upper(trim(coalesce(p_coupon_code, '')));

  IF v_normalized_coupon <> '' THEN
    v_coupon_result := public.validate_coupon(p_coupon_code);
    IF coalesce((v_coupon_result->>'valid')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION '%', coalesce(v_coupon_result->>'message', 'Invalid coupon');
    END IF;
    v_discount := coalesce((v_coupon_result->>'discount_percentage')::numeric, 0);
  END IF;

  v_final := greatest(
    0,
    round(v_base * (1 - least(100, greatest(0, v_discount)) / 100))
  );

  IF v_final > 0 THEN
    RAISE EXCEPTION 'This product requires payment';
  END IF;

  IF p_product_type = 'internship' THEN
    INSERT INTO public.internship_applications (
      user_id, internship_id, status,
      full_name, phone, email, college_name, degree, graduation_year, specialization,
      amount_paid, coupon_code_used, coupon_discount_percent
    ) VALUES (
      p_user_id,
      p_internship_id,
      'applied',
      NULLIF(trim(p_details->>'full_name'), ''),
      NULLIF(trim(p_details->>'phone'), ''),
      NULLIF(trim(p_details->>'email'), ''),
      NULLIF(trim(p_details->>'college_name'), ''),
      NULLIF(trim(p_details->>'degree'), ''),
      NULLIF(trim(p_details->>'graduation_year'), '')::integer,
      NULLIF(trim(p_details->>'specialization'), ''),
      0,
      NULLIF(v_normalized_coupon, ''),
      CASE WHEN v_normalized_coupon <> '' THEN v_discount ELSE NULL END
    );
  ELSE
    INSERT INTO public.enrollments (
      user_id, course_id,
      full_name, phone, email, college_name, degree, degree_year, specialization,
      live_class_start_month, amount_paid,
      coupon_code_used, coupon_discount_percent
    ) VALUES (
      p_user_id,
      p_course_id,
      NULLIF(trim(p_details->>'full_name'), ''),
      NULLIF(trim(p_details->>'phone'), ''),
      NULLIF(trim(p_details->>'email'), ''),
      NULLIF(trim(p_details->>'college_name'), ''),
      NULLIF(trim(p_details->>'degree'), ''),
      NULLIF(trim(p_details->>'degree_year'), '')::integer,
      NULLIF(trim(p_details->>'specialization'), ''),
      NULLIF(trim(p_details->>'live_class_start_month'), ''),
      0,
      NULLIF(v_normalized_coupon, ''),
      CASE WHEN v_normalized_coupon <> '' THEN v_discount ELSE NULL END
    );
  END IF;

  IF v_normalized_coupon <> '' THEN
    v_coupon_ok := public.try_increment_coupon_usage(p_coupon_code);
    IF NOT v_coupon_ok THEN
      RAISE EXCEPTION 'Coupon usage limit reached or coupon no longer valid';
    END IF;
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_paid_enrollment(uuid, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_free_enrollment(uuid, text, uuid, uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_paid_enrollment(uuid, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_free_enrollment(uuid, text, uuid, uuid, text, jsonb) TO service_role;
