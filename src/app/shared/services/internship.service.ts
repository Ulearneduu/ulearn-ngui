import { Injectable } from '@angular/core';
import { from, Observable, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { Internship, InternshipType } from '../../models';
import { supabase } from '../../core/supabase.client';

export interface InternshipsLoadResult {
  internships: Internship[];
  error: string | null;
  errorCode?: string;
}

/** Maps PostgREST / Postgres errors to user-safe messages (no secrets). */
export function formatInternshipQueryError(error: {
  code?: string;
  message?: string;
  details?: string;
}): string {
  const msg = error.message ?? '';
  const code = error.code ?? '';

  if (code === '42703' && /price|original_price/i.test(msg)) {
    return (
      'Internship pricing columns are missing in the database. Apply the Supabase migration ' +
      'supabase/migrations/20261103_internship_enrollment_payment.sql (see project docs or run `supabase db push`).'
    );
  }

  if (code === '42P01' || /relation.*internships.*does not exist/i.test(msg)) {
    return 'The internships table is missing. Apply base migrations (20260621_internships_and_papers.sql) in Supabase.';
  }

  if (code === 'PGRST116') {
    return 'No internship record found.';
  }

  if (/permission denied|row-level security/i.test(msg)) {
    return 'Could not read internships: database permission denied. Check RLS policies for public read on open listings.';
  }

  if (/fetch failed|network|Failed to fetch/i.test(msg)) {
    return 'Could not reach the database. Check your network connection and Supabase project URL.';
  }

  return msg || 'Could not load internships from the database.';
}

function logInternshipQueryError(context: string, error: { code?: string; message?: string }): void {
  console.error(`InternshipService.${context}:`, {
    code: error.code ?? 'unknown',
    message: error.message ?? 'Unknown error'
  });
}

@Injectable({ providedIn: 'root' })
export class InternshipService {
  private readonly fields =
    'id, title, type, mode, domain, description, duration_label, stipend_per_month, price, original_price, has_ppo, skills, thumbnail_url, status, created_at';

  loadOpenInternships(): Observable<InternshipsLoadResult> {
    return from(
      supabase
        .from('internships')
        .select(this.fields)
        .eq('status', 'open')
        .order('stipend_per_month', { ascending: false })
    ).pipe(
      map(({ data, error }) => {
        if (error) {
          logInternshipQueryError('loadOpenInternships', error);
          return {
            internships: [],
            error: formatInternshipQueryError(error),
            errorCode: error.code
          };
        }
        return {
          internships: (data ?? []).map((r) => this.mapRow(r as Record<string, unknown>)),
          error: null
        };
      }),
      catchError((err: { code?: string; message?: string }) => {
        logInternshipQueryError('loadOpenInternships(catch)', err);
        return of({
          internships: [],
          error: formatInternshipQueryError(err),
          errorCode: err.code
        });
      })
    );
  }

  /** @deprecated Prefer loadOpenInternships() for error visibility */
  getInternships(): Observable<Internship[]> {
    return this.loadOpenInternships().pipe(map((r) => r.internships));
  }

  loadOpenInternshipsByType(type: InternshipType): Observable<InternshipsLoadResult> {
    return from(
      supabase
        .from('internships')
        .select(this.fields)
        .eq('status', 'open')
        .eq('type', type)
        .order('stipend_per_month', { ascending: false })
    ).pipe(
      map(({ data, error }) => {
        if (error) {
          logInternshipQueryError('loadOpenInternshipsByType', error);
          return {
            internships: [],
            error: formatInternshipQueryError(error),
            errorCode: error.code
          };
        }
        return {
          internships: (data ?? []).map((r) => this.mapRow(r as Record<string, unknown>)),
          error: null
        };
      }),
      catchError((err: { code?: string; message?: string }) => {
        logInternshipQueryError('loadOpenInternshipsByType(catch)', err);
        return of({
          internships: [],
          error: formatInternshipQueryError(err),
          errorCode: err.code
        });
      })
    );
  }

  getInternshipsByType(type: InternshipType): Observable<Internship[]> {
    return this.loadOpenInternshipsByType(type).pipe(map((r) => r.internships));
  }

  getInternshipById(id: string): Observable<Internship | null> {
    return from(
      supabase.from('internships').select(this.fields).eq('id', id).maybeSingle()
    ).pipe(
      map(({ data, error }) => {
        if (error) {
          logInternshipQueryError('getInternshipById', error);
          throw error;
        }
        if (!data) return null;
        return this.mapRow(data as Record<string, unknown>);
      }),
      catchError((err) => {
        logInternshipQueryError('getInternshipById(catch)', err);
        return of(null);
      })
    );
  }

  private mapRow(r: Record<string, unknown>): Internship {
    return {
      id: String(r['id']),
      title: String(r['title'] ?? ''),
      type: r['type'] as Internship['type'],
      mode: r['mode'] as Internship['mode'],
      domain: String(r['domain'] ?? ''),
      description: String(r['description'] ?? ''),
      durationLabel: String(r['duration_label'] ?? ''),
      stipendPerMonth: Number(r['stipend_per_month'] ?? 0),
      price: Number(r['price'] ?? 0),
      originalPrice:
        r['original_price'] != null ? Number(r['original_price']) : undefined,
      hasPPO: Boolean(r['has_ppo']),
      skills: Array.isArray(r['skills']) ? (r['skills'] as string[]) : [],
      thumbnailUrl: (r['thumbnail_url'] as string) || undefined,
      status: (r['status'] as Internship['status']) ?? 'open',
      createdAt: String(r['created_at'] ?? '')
    };
  }
}
