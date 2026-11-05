# Supabase Edge Functions

Edge Function source lives in this repository under `supabase/functions/`. **Deploying to your Supabase project is a separate step** (CLI or Dashboard). Nothing in this README implies that a given function is already live on production or staging unless you have deployed it yourself.

## Razorpay Edge Function secrets

Set these in **Supabase Dashboard → Project Settings → Edge Functions → Secrets**:

| Secret | Value |
|--------|-------|
| `RAZORPAY_KEY_ID` | `rzp_live_T1SJOKA8QCXSV1` |
| `RAZORPAY_KEY_SECRET` | *(set in Supabase Dashboard — do not commit)* |

The Angular app uses `razorpayKeyId` from `environment.ts` (public key only).

## Enrollment payment functions (source in repo)

These three functions implement secure paid and free enrollment. They are **not** deployed automatically when you clone or push the repo; apply database migrations first, set secrets, then deploy each function explicitly.

| Function | Role |
|----------|------|
| `create-razorpay-order` | Authenticated user; loads product price from the database; validates coupons server-side; inserts `payment_orders`; creates a Razorpay order for the server-computed amount (client amounts are not trusted). |
| `verify-razorpay-payment` | Authenticated user; full server-side verification before any enrollment write (see below); calls `finalize_paid_enrollment` RPC for atomic paid finalization. |
| `complete-free-enrollment` | Authenticated user; validates free or fully discounted checkout server-side; calls `finalize_free_enrollment` RPC. |

Deploy after migrations and secrets (example):

```bash
npx supabase functions deploy create-razorpay-order
npx supabase functions deploy verify-razorpay-payment
npx supabase functions deploy complete-free-enrollment
```

### `verify-razorpay-payment` behavior

The handler runs checks in order; any failure returns an error without calling the finalize RPC (except where idempotent replay is handled inside the RPC for an already-completed paid order).

1. **Authentication** — Valid Supabase JWT; anonymous requests are rejected.
2. **Payment payload strings** — `razorpay_order_id`, `razorpay_payment_id`, and `razorpay_signature` must be non-empty strings (trimmed) before any crypto or API calls.
3. **Product context** — Request must identify exactly one of `courseId` or `internshipId`, matching the stored `payment_orders` row.
4. **HMAC signature verification** — Razorpay checkout signature is verified with `RAZORPAY_KEY_SECRET` using the order id and payment id from the client callback.
5. **Payment order ownership** — Loads `payment_orders` by `razorpay_order_id`; row must exist, belong to the authenticated user, match the submitted course/internship, and be in a verifiable status (`pending` or `paid` for replay).
6. **Razorpay Orders API** — GET `https://api.razorpay.com/v1/orders/{id}`; requires a successful response; validates returned order id, **amount** (must equal `payment_orders.amount_paise`), and **currency** (must equal `payment_orders.currency`).
7. **Razorpay Payments API** — Independent GET `https://api.razorpay.com/v1/payments/{id}`; requires a successful response; validates payment id, linked order id, amount, currency, and **`captured`** status (non-captured payments are rejected).
8. **Enrollment details** — Course or internship enrollment fields are validated in the Edge Function, then passed as JSON to the database.
9. **Paid finalization** — **`finalize_paid_enrollment` RPC** (PostgreSQL, `SECURITY DEFINER`) performs enrollment/application insert, coupon usage, and marking the order paid inside a single transaction. The Edge Function does not insert enrollments directly.

Shared validation helpers live in `supabase/functions/_shared/` (also exercised by Node scripts under `scripts/`).

## Database migrations (enrollment payment)

Apply **in this order** on the target Supabase project (e.g. `npx supabase db push` or run SQL in the SQL editor):

| Order | File | Purpose |
|-------|------|---------|
| 1 | `supabase/migrations/20261103_internship_enrollment_payment.sql` | Internship pricing columns; internship application fields for enrollment/payment metadata (including Razorpay ids on applications). |
| 2 | `supabase/migrations/20261104_secure_enrollment_payment.sql` | `payment_orders` table, replay-protection indexes, server-authoritative checkout; RLS tightening so users cannot self-insert paid enrollments/applications. |
| 3 | `supabase/migrations/20261105_enrollment_finalize_transaction.sql` | `finalize_paid_enrollment` and `finalize_free_enrollment` RPCs — transactional paid/free finalization (depends on 20261104). |

**Preflight** before 20261104: run `scripts/preflight-20261104-enrollment.sql` and resolve any reported issues.

Migrations in the repo are **not** applied to remote projects until you run them; deploy Edge Functions only after the migrations your environment needs are applied.

## Other functions in this repository

These handlers also live under `supabase/functions/`; deploy them separately when you use those features:

- `delete-user` — admin deletes student account and related data
- `create-student` — admin creates student(s) with temp password, optional enroll & batch
- `resend-credentials` — admin resets temp password and emails student
- `admin-reset-password` — signed-in admin emails themselves a temporary password and must set a new one
- `send-signup-otp`, `verify-signup-otp`, `complete-signup` — public signup email OTP. Deploy these three with `--no-verify-jwt`
- `send-promotion-email` — staff with the promotions permission send a message, inline images, and attachments to one or many addresses
- `livekit-token` — mints LiveKit JWT for session join links (requires LiveKit secrets)

### LiveKit secrets

| Secret | Value |
|--------|-------|
| `LIVEKIT_API_KEY` | From LiveKit Cloud project settings |
| `LIVEKIT_API_SECRET` | From LiveKit Cloud project settings |
| `LIVEKIT_WS_URL` | e.g. `wss://your-project.livekit.cloud` |

### Student provisioning email (optional)

| Secret | Value |
|--------|-------|
| `RESEND_API_KEY` | Resend API key |
| `RESEND_FROM_EMAIL` | e.g. `ULearn <noreply@ulearn-edu.in>` |
| `ULEARN_LOGIN_URL` | e.g. `https://www.ulearn-edu.in/auth/login` |

## Tests

Pricing and verify validation helpers (Node):

```bash
npm run test:enrollment-payment
npm run test:enrollment-finalize
npm run test:razorpay-payment-verify
```

Deno unit tests for shared TS helpers (when using Deno locally):

```bash
deno test supabase/functions/_shared/enrollment-payment_test.ts
```
