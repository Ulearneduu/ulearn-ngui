-- Internship enrollment fee + application detail fields for paid/free enroll flow

ALTER TABLE public.internships
  ADD COLUMN IF NOT EXISTS price integer NOT NULL DEFAULT 0 CHECK (price >= 0),
  ADD COLUMN IF NOT EXISTS original_price integer CHECK (original_price IS NULL OR original_price >= 0);

ALTER TABLE public.internship_applications
  ADD COLUMN IF NOT EXISTS full_name text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS college_name text,
  ADD COLUMN IF NOT EXISTS degree text,
  ADD COLUMN IF NOT EXISTS graduation_year integer,
  ADD COLUMN IF NOT EXISTS specialization text,
  ADD COLUMN IF NOT EXISTS coupon_code_used text,
  ADD COLUMN IF NOT EXISTS coupon_discount_percent numeric(5,2),
  ADD COLUMN IF NOT EXISTS amount_paid numeric(12,2),
  ADD COLUMN IF NOT EXISTS razorpay_order_id text,
  ADD COLUMN IF NOT EXISTS razorpay_payment_id text;
