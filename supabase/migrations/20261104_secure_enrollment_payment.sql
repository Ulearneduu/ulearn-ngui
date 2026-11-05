-- Secure enrollment payment: trusted order records, replay protection, tighter RLS

-- ─── Payment orders (server-authoritative checkout state) ───────────────────

CREATE TABLE IF NOT EXISTS public.payment_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  product_type text NOT NULL CHECK (product_type IN ('course', 'internship')),
  course_id uuid REFERENCES public.courses(id) ON DELETE RESTRICT,
  internship_id uuid REFERENCES public.internships(id) ON DELETE RESTRICT,
  base_amount_paise integer NOT NULL CHECK (base_amount_paise >= 0),
  discount_percent numeric(5,2) CHECK (discount_percent IS NULL OR (discount_percent > 0 AND discount_percent <= 100)),
  coupon_code text,
  amount_paise integer NOT NULL CHECK (amount_paise >= 0),
  currency text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  razorpay_order_id text,
  razorpay_payment_id text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'failed', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  CONSTRAINT payment_orders_one_product CHECK (
    (product_type = 'course' AND course_id IS NOT NULL AND internship_id IS NULL)
    OR (product_type = 'internship' AND internship_id IS NOT NULL AND course_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_orders_razorpay_order_id_unique
  ON public.payment_orders (razorpay_order_id)
  WHERE razorpay_order_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS payment_orders_razorpay_payment_id_unique
  ON public.payment_orders (razorpay_payment_id)
  WHERE razorpay_payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS payment_orders_user_status_idx
  ON public.payment_orders (user_id, status, created_at DESC);

ALTER TABLE public.payment_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own payment orders" ON public.payment_orders;
CREATE POLICY "Users read own payment orders" ON public.payment_orders
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- Inserts/updates only via service role (edge functions)

-- ─── Duplicate enrollment protection ──────────────────────────────────────────
-- Preflight (manual): scripts/preflight-20261104-enrollment.sql

DO $$
DECLARE
  v_dup_groups integer;
  v_dup_payment_ids integer;
  v_dup_order_ids integer;
BEGIN
  SELECT COUNT(*) INTO v_dup_groups
  FROM (
    SELECT user_id, course_id
    FROM public.enrollments
    GROUP BY user_id, course_id
    HAVING COUNT(*) > 1
  ) dup;

  IF v_dup_groups > 0 THEN
    RAISE EXCEPTION
      'Migration blocked: % duplicate (user_id, course_id) enrollment group(s). '
      'Resolve duplicates without deleting enrollment data, then re-run. '
      'Preflight: scripts/preflight-20261104-enrollment.sql',
      v_dup_groups;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'enrollments_user_course_unique'
      AND conrelid = 'public.enrollments'::regclass
  ) THEN
    ALTER TABLE public.enrollments
      ADD CONSTRAINT enrollments_user_course_unique UNIQUE (user_id, course_id);
  END IF;

  SELECT COUNT(*) INTO v_dup_payment_ids
  FROM (
    SELECT razorpay_payment_id
    FROM public.internship_applications
    WHERE razorpay_payment_id IS NOT NULL
    GROUP BY razorpay_payment_id
    HAVING COUNT(*) > 1
  ) dup;

  IF v_dup_payment_ids > 0 THEN
    RAISE EXCEPTION
      'Migration blocked: % duplicate non-null razorpay_payment_id value(s) on internship_applications. '
      'Preflight: scripts/preflight-20261104-enrollment.sql',
      v_dup_payment_ids;
  END IF;

  SELECT COUNT(*) INTO v_dup_order_ids
  FROM (
    SELECT razorpay_order_id
    FROM public.internship_applications
    WHERE razorpay_order_id IS NOT NULL
    GROUP BY razorpay_order_id
    HAVING COUNT(*) > 1
  ) dup;

  IF v_dup_order_ids > 0 THEN
    RAISE EXCEPTION
      'Migration blocked: % duplicate non-null razorpay_order_id value(s) on internship_applications. '
      'Preflight: scripts/preflight-20261104-enrollment.sql',
      v_dup_order_ids;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS internship_applications_razorpay_payment_id_unique
  ON public.internship_applications (razorpay_payment_id)
  WHERE razorpay_payment_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS internship_applications_razorpay_order_id_unique
  ON public.internship_applications (razorpay_order_id)
  WHERE razorpay_order_id IS NOT NULL;

-- ─── Coupon usage (atomic, limit-aware) ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.try_increment_coupon_usage(p_code text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_normalized text;
  v_updated integer;
BEGIN
  v_normalized := upper(trim(coalesce(p_code, '')));
  IF v_normalized = '' THEN
    RETURN false;
  END IF;

  UPDATE public.discount_coupons
  SET usage_count = usage_count + 1,
      updated_at = now()
  WHERE upper(code) = v_normalized
    AND active = true
    AND (expires_at IS NULL OR expires_at >= now())
    AND (max_uses IS NULL OR usage_count < max_uses);

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.try_increment_coupon_usage(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.try_increment_coupon_usage(text) TO service_role;

GRANT EXECUTE ON FUNCTION public.validate_coupon(text) TO service_role;

-- ─── Block direct client inserts for paid-path bypass ───────────────────────
-- Paid enrollments/applications must go through edge functions (service role).

DROP POLICY IF EXISTS "Users insert own enrollments" ON public.enrollments;
CREATE POLICY "Users insert own enrollments" ON public.enrollments
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.courses c
      WHERE c.id = course_id
        AND c.status = 'published'
        AND coalesce(c.price, 0) <= 0
    )
  );

DROP POLICY IF EXISTS "Users insert own internship applications" ON public.internship_applications;
CREATE POLICY "Users insert own internship applications" ON public.internship_applications
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    AND status = 'applied'
    AND EXISTS (
      SELECT 1 FROM public.internships i
      WHERE i.id = internship_id
        AND i.status = 'open'
        AND coalesce(i.price, 0) <= 0
    )
  );
