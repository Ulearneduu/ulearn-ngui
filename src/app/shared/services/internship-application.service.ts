import { Injectable } from '@angular/core';
import { from, Observable, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { InternshipApplication, InternshipApplicationStatus, InternshipEnrollmentFormData } from '../../models';
import { supabase } from '../../core/supabase.client';

@Injectable({ providedIn: 'root' })
export class InternshipApplicationService {
  private readonly fields =
    'id, internship_id, user_id, status, applied_at, updated_at';

  async applyForInternship(internshipId: string, userId: string): Promise<boolean> {
    return this.submitEnrollment(internshipId, userId);
  }

  async submitEnrollment(
    internshipId: string,
    userId: string,
    details?: InternshipEnrollmentFormData,
    amountPaid?: number
  ): Promise<boolean> {
    const alreadyApplied = await this.hasApplied(internshipId, userId);
    if (alreadyApplied) return true;

    const payload: Record<string, unknown> = {
      internship_id: internshipId,
      user_id: userId,
      status: 'applied'
    };

    if (details) {
      payload['full_name'] = details.fullName;
      payload['phone'] = details.phone;
      payload['email'] = details.email;
      payload['college_name'] = details.collegeName;
      payload['degree'] = details.degree;
      payload['graduation_year'] = details.graduationYear;
      payload['specialization'] = details.specialization;
      if (details.couponCode) {
        payload['coupon_code_used'] = details.couponCode;
        payload['coupon_discount_percent'] = details.couponDiscountPercent ?? null;
      }
    }

    if (amountPaid != null) {
      payload['amount_paid'] = amountPaid;
    }

    const { error } = await supabase.from('internship_applications').insert(payload);

    if (error) {
      console.error('InternshipApplicationService.submitEnrollment:', error);
      return false;
    }
    return true;
  }

  getUserApplications(userId: string): Observable<InternshipApplication[]> {
    return from(
      supabase
        .from('internship_applications')
        .select(this.fields)
        .eq('user_id', userId)
        .order('applied_at', { ascending: false })
    ).pipe(
      map(({ data, error }) => {
        if (error) throw error;
        return (data ?? []).map((r) => this.mapRow(r as Record<string, unknown>));
      }),
      catchError((err) => {
        console.error('InternshipApplicationService.getUserApplications:', err);
        return of([]);
      })
    );
  }

  getUserAppliedInternshipIds(userId: string): Observable<Set<string>> {
    return this.getUserApplications(userId).pipe(
      map((apps) => new Set(apps.map((a) => a.internshipId)))
    );
  }

  async hasApplied(internshipId: string, userId: string): Promise<boolean> {
    const { data, error } = await supabase
      .from('internship_applications')
      .select('id')
      .eq('internship_id', internshipId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      console.error('InternshipApplicationService.hasApplied:', error);
      return false;
    }
    return Boolean(data);
  }

  private mapRow(r: Record<string, unknown>): InternshipApplication {
    return {
      id: String(r['id']),
      internshipId: String(r['internship_id']),
      userId: String(r['user_id']),
      status: r['status'] as InternshipApplicationStatus,
      appliedAt: String(r['applied_at'] ?? ''),
      updatedAt: String(r['updated_at'] ?? '')
    };
  }
}
