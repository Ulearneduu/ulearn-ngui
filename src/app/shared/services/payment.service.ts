import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { ToastService } from '../../core/services/toast';
import { AuthService } from '../../core/services/auth.service';
import { supabase } from '../../core/supabase.client';
import { environment } from '../../../environments/environment';
import { EnrollmentFormData, InternshipEnrollmentFormData } from '../../models';

export interface PendingCourseCheckout {
  kind: 'course';
  courseId: string;
  slug: string;
  price: number;
  basePrice: number;
  title?: string;
  formData: EnrollmentFormData;
}

export interface PendingInternshipCheckout {
  kind: 'internship';
  internshipId: string;
  price: number;
  basePrice: number;
  title?: string;
  returnUrl?: string;
  formData: InternshipEnrollmentFormData;
}

export type PendingCheckout = PendingCourseCheckout | PendingInternshipCheckout;

/** @deprecated Use PendingCourseCheckout — kept for course enroll modal */
export type PendingEnrollment = PendingCourseCheckout;

interface RazorpayResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

interface RazorpayInstance {
  open(): void;
  on(event: string, handler: (response: { error?: { description?: string } }) => void): void;
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

const PENDING_KEY = 'ul_pending_enrollment';

@Injectable({ providedIn: 'root' })
export class PaymentService {
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly auth = inject(AuthService);

  setPendingEnrollment(data: Omit<PendingCourseCheckout, 'kind'>): void {
    this.setPendingCheckout({ kind: 'course', ...data });
  }

  setPendingInternshipCheckout(data: Omit<PendingInternshipCheckout, 'kind'>): void {
    this.setPendingCheckout({ kind: 'internship', ...data });
  }

  setPendingCheckout(data: PendingCheckout): void {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(data));
  }

  getPendingCheckout(): PendingCheckout | null {
    try {
      const raw = sessionStorage.getItem(PENDING_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed['kind'] === 'internship') {
        return parsed as unknown as PendingInternshipCheckout;
      }
      if (parsed['kind'] === 'course') {
        return parsed as unknown as PendingCourseCheckout;
      }
      if (parsed['courseId']) {
        return { kind: 'course', ...(parsed as Omit<PendingCourseCheckout, 'kind'>) };
      }
      return null;
    } catch {
      return null;
    }
  }

  getPendingEnrollment(): PendingCourseCheckout | null {
    const pending = this.getPendingCheckout();
    return pending?.kind === 'course' ? pending : null;
  }

  clearPendingEnrollment(): void {
    sessionStorage.removeItem(PENDING_KEY);
  }

  /** Razorpay modal locks body scroll — restore after close. */
  unlockPageScroll(): void {
    document.body.classList.remove('razorpay-body');
    document.body.style.removeProperty('overflow');
    document.body.style.removeProperty('position');
    document.body.style.removeProperty('height');
    document.body.style.removeProperty('top');
    document.body.style.removeProperty('width');
    document.documentElement.style.removeProperty('overflow');
    document.documentElement.classList.remove('razorpay-body');
  }

  private loadRazorpayScript(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (window.Razorpay) {
        resolve();
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Failed to load Razorpay'));
      document.body.appendChild(script);
    });
  }

  async startCheckout(pending: PendingCourseCheckout): Promise<boolean> {
    return this.processCheckout(pending);
  }

  async startInternshipCheckout(pending: PendingInternshipCheckout): Promise<boolean> {
    return this.processCheckout(pending);
  }

  private async processCheckout(pending: PendingCheckout): Promise<boolean> {
    const user = this.auth.currentUser();
    if (!user) {
      this.toast.error('Please log in to enroll');
      return false;
    }

    if (pending.price <= 0) {
      return this.enrollFree(pending);
    }

    try {
      await this.loadRazorpayScript();
    } catch {
      this.toast.error('Could not load payment gateway');
      return false;
    }

    const couponCode = pending.formData.couponCode?.trim() || undefined;
    const orderBody =
      pending.kind === 'course'
        ? { courseId: pending.courseId, couponCode }
        : { internshipId: pending.internshipId, couponCode };

    const { data, error } = await supabase.functions.invoke('create-razorpay-order', {
      body: orderBody
    });

    if (error || !data?.orderId) {
      console.error('create-razorpay-order error:', error, data);
      this.toast.error(data?.error || 'Could not create payment order');
      return false;
    }

    const profile = this.auth.profile();
    const userName =
      pending.formData.fullName ||
      profile?.full_name ||
      (user.user_metadata?.['full_name'] as string | undefined) ||
      user.email.split('@')[0];

    const description =
      pending.title ||
      (pending.kind === 'course' ? 'Course enrollment' : 'Internship enrollment');

    return new Promise((resolve) => {
      const options: Record<string, unknown> = {
        key: environment.razorpayKeyId,
        amount: data.amount,
        currency: data.currency,
        name: environment.appName,
        description,
        order_id: data.orderId,
        handler: (response: RazorpayResponse) => {
          void this.verifyAndComplete(pending, response).then(resolve);
        },
        prefill: {
          name: userName,
          email: pending.formData.email || user.email,
          contact: pending.formData.phone || profile?.phone || undefined
        },
        theme: { color: '#8B6FBE' },
        modal: {
          ondismiss: () => {
            this.unlockPageScroll();
            resolve(false);
          }
        }
      };

      const rzp = new window.Razorpay!(options);
      rzp.on('payment.failed', (res) => {
        this.unlockPageScroll();
        this.toast.error(res.error?.description || 'Payment failed');
        resolve(false);
      });
      rzp.open();
    });
  }

  private async verifyAndComplete(
    pending: PendingCheckout,
    response: RazorpayResponse
  ): Promise<boolean> {
    const body: Record<string, unknown> = {
      razorpay_order_id: response.razorpay_order_id,
      razorpay_payment_id: response.razorpay_payment_id,
      razorpay_signature: response.razorpay_signature
    };

    if (pending.kind === 'course') {
      body['courseId'] = pending.courseId;
      body['enrollmentDetails'] = pending.formData;
    } else {
      body['internshipId'] = pending.internshipId;
      body['internshipEnrollmentDetails'] = pending.formData;
    }

    const { data, error } = await supabase.functions.invoke('verify-razorpay-payment', { body });

    if (error || !data?.success) {
      console.error('verify-razorpay-payment error:', error, data);
      this.unlockPageScroll();
      this.toast.error(data?.error || 'Payment verification failed');
      return false;
    }

    this.clearPendingEnrollment();
    this.unlockPageScroll();
    this.toast.success(
      pending.kind === 'course'
        ? 'Payment successful! You are now enrolled.'
        : 'Payment successful! Your internship enrollment is confirmed.'
    );
    await this.navigateAfterSuccess(pending);
    return true;
  }

  private async enrollFree(pending: PendingCheckout): Promise<boolean> {
    const user = this.auth.currentUser();
    if (!user) return false;

    const couponCode = pending.formData.couponCode?.trim() || undefined;
    const body: Record<string, unknown> = { couponCode };

    if (pending.kind === 'course') {
      body['courseId'] = pending.courseId;
      body['enrollmentDetails'] = pending.formData;
    } else {
      body['internshipId'] = pending.internshipId;
      body['internshipEnrollmentDetails'] = pending.formData;
    }

    const { data, error } = await supabase.functions.invoke('complete-free-enrollment', { body });

    if (error || !data?.success) {
      console.error('complete-free-enrollment error:', error, data);
      this.toast.error(data?.error || 'Enrollment failed');
      return false;
    }

    this.clearPendingEnrollment();
    this.toast.success(
      pending.kind === 'course' ? 'Enrolled successfully!' : 'Enrolled in internship successfully!'
    );
    await this.navigateAfterSuccess(pending);
    return true;
  }

  private async navigateAfterSuccess(pending: PendingCheckout): Promise<void> {
    if (pending.kind === 'internship' && pending.returnUrl) {
      await this.router.navigateByUrl(pending.returnUrl);
      return;
    }
    if (pending.kind === 'course') {
      await this.router.navigate(['/my-courses']);
      return;
    }
    await this.router.navigate(['/internships/short']);
  }

  async resumePendingPayment(): Promise<void> {
    const pending = this.getPendingCheckout();
    if (!pending) return;
    await this.processCheckout(pending);
  }
}
