import { Injectable } from '@angular/core';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { invokeAuthedFunction } from '../core/supabase.client';

export interface InterviewQuota {
  weekly_limit: number;
  limit?: number;
  used: number;
  remaining: number;
  week_starts_at: string;
  resets_at: string;
}

export interface InterviewStartSuccess extends InterviewQuota {
  session_id: string;
  status: string;
  resumed?: boolean;
}

type InterviewStartPayload = InterviewStartSuccess & { resumed?: boolean };

export interface InterviewQuotaExceeded {
  code: 'WEEKLY_QUOTA_EXCEEDED';
  weekly_limit?: number;
  limit: number;
  used: number;
  remaining: 0;
  week_starts_at: string;
  resets_at: string;
}

export type InterviewQuotaLoadResult =
  | { ok: true; quota: InterviewQuota }
  | { ok: false; error: string };

export type InterviewStartOutcome =
  | { ok: true; result: InterviewStartSuccess }
  | {
      ok: false;
      error: string;
      quotaExhausted?: boolean;
      quota?: InterviewQuota;
      quotaDetailsIncomplete?: boolean;
    };

const QUOTA_EXHAUSTED_MESSAGE =
  'Weekly mock interview limit reached. Try again after the reset time shown below.';

@Injectable({
  providedIn: 'root'
})
export class InterviewService {
  /** Last successful quota load; used to fill 429 UI when the error body is partial. */
  private lastKnownQuota: InterviewQuota | null = null;

  async loadQuota(): Promise<InterviewQuotaLoadResult> {
    const { data, error } = await invokeAuthedFunction<InterviewQuota>(
      'interview-quota-status',
      {}
    );

    if (error) {
      return { ok: false, error: await this.formatInvokeError(error) };
    }

    if (!data || typeof data.used !== 'number') {
      return { ok: false, error: 'Could not load weekly interview quota.' };
    }

    const quota = this.normalizeQuota(data);
    this.lastKnownQuota = quota;
    return { ok: true, quota };
  }

  async startInterview(options?: { resumeSessionId?: string }): Promise<InterviewStartOutcome> {
    const body: Record<string, unknown> = {};
    if (options?.resumeSessionId) {
      body['session_id'] = options.resumeSessionId;
    }

    const { data, error } = await invokeAuthedFunction<
      InterviewStartSuccess | InterviewQuotaExceeded
    >('interview-start', body);

    if (error) {
      const parsed = await this.parseHttpError(error);
      if (parsed.quotaExhausted) {
        const quota = this.mergeExhaustedQuota(parsed.quota);
        return {
          ok: false,
          error: this.exhaustedUserMessage(quota),
          quotaExhausted: true,
          quota,
          quotaDetailsIncomplete: parsed.quotaDetailsIncomplete
        };
      }
      return { ok: false, error: parsed.message };
    }

    if (this.isQuotaExceededPayload(data)) {
      const quota = this.mergeExhaustedQuota(this.quotaFromExhaustedPayload(data));
      return {
        ok: false,
        error: this.exhaustedUserMessage(quota),
        quotaExhausted: true,
        quota
      };
    }

    const payload = data as InterviewStartPayload | null;
    if (!payload?.session_id) {
      return { ok: false, error: 'Interview session could not be started.' };
    }

    const result = {
      ...this.normalizeQuota(payload),
      session_id: payload.session_id,
      status: payload.status ?? 'started',
      resumed: payload.resumed === true
    };
    this.lastKnownQuota = this.normalizeQuota(result);

    return { ok: true, result };
  }

  private exhaustedUserMessage(quota: InterviewQuota | undefined): string {
    if (quota && this.hasDisplayableQuota(quota)) {
      return QUOTA_EXHAUSTED_MESSAGE;
    }
    return 'Weekly mock interview limit reached. Refresh the page to see when your quota resets.';
  }

  private hasDisplayableQuota(quota: InterviewQuota): boolean {
    return (
      quota.weekly_limit > 0 &&
      typeof quota.used === 'number' &&
      Boolean(quota.resets_at)
    );
  }

  private mergeExhaustedQuota(partial?: InterviewQuota): InterviewQuota | undefined {
    if (!partial && !this.lastKnownQuota) {
      return undefined;
    }
    const base = partial ?? ({} as InterviewQuota);
    const cached = this.lastKnownQuota;
    const weeklyLimit = base.weekly_limit || base.limit || cached?.weekly_limit || 0;
    const used =
      typeof base.used === 'number' ? base.used : (cached?.used ?? weeklyLimit);
    const weekStarts =
      base.week_starts_at || cached?.week_starts_at || '';
    const resets = base.resets_at || cached?.resets_at || '';

    if (!weeklyLimit && !resets) {
      return undefined;
    }

    return {
      weekly_limit: weeklyLimit,
      limit: base.limit ?? weeklyLimit,
      used,
      remaining: 0,
      week_starts_at: weekStarts,
      resets_at: resets
    };
  }

  private quotaFromExhaustedPayload(data: InterviewQuotaExceeded): InterviewQuota {
    const weeklyLimit = data.weekly_limit ?? data.limit ?? 0;
    return {
      weekly_limit: weeklyLimit,
      limit: data.limit ?? weeklyLimit,
      used: data.used,
      remaining: 0,
      week_starts_at: data.week_starts_at,
      resets_at: data.resets_at
    };
  }

  private normalizeQuota(raw: InterviewQuota): InterviewQuota {
    const weeklyLimit = raw.weekly_limit ?? raw.limit ?? 0;
    return {
      weekly_limit: weeklyLimit,
      limit: raw.limit ?? weeklyLimit,
      used: raw.used,
      remaining: raw.remaining,
      week_starts_at: raw.week_starts_at,
      resets_at: raw.resets_at
    };
  }

  private async parseHttpError(error: unknown): Promise<{
    message: string;
    quotaExhausted?: boolean;
    quota?: InterviewQuota;
    quotaDetailsIncomplete?: boolean;
  }> {
    if (error instanceof FunctionsHttpError) {
      const status = error.context.status;
      let body: Record<string, unknown> | null = null;
      try {
        body = (await error.context.json()) as Record<string, unknown>;
      } catch {
        body = null;
      }

      if (body) {
        if (body['code'] === 'WEEKLY_QUOTA_EXCEEDED') {
          const quota = this.mergeExhaustedQuota(this.quotaFromPartialBody(body));
          return {
            message: this.exhaustedUserMessage(quota),
            quotaExhausted: true,
            quota,
            quotaDetailsIncomplete: !quota || !this.hasDisplayableQuota(quota)
          };
        }
        if (typeof body['error'] === 'string') {
          return { message: body['error'] };
        }
      }

      if (status === 429) {
        const quota = this.mergeExhaustedQuota(
          body ? this.quotaFromPartialBody(body) : undefined
        );
        return {
          message: this.exhaustedUserMessage(quota),
          quotaExhausted: true,
          quota,
          quotaDetailsIncomplete: !quota || !this.hasDisplayableQuota(quota)
        };
      }
      if (status === 403) {
        return { message: 'Interview access denied.' };
      }
      if (status === 401) {
        return { message: 'Please sign in again to start an interview.' };
      }
    }
    return {
      message: error instanceof Error ? error.message : 'Request failed'
    };
  }

  private quotaFromPartialBody(body: Record<string, unknown>): InterviewQuota | undefined {
    const used = typeof body['used'] === 'number' ? body['used'] : undefined;
    const weeklyLimit =
      typeof body['weekly_limit'] === 'number'
        ? body['weekly_limit']
        : typeof body['limit'] === 'number'
          ? body['limit']
          : undefined;
    const resets =
      typeof body['resets_at'] === 'string' ? body['resets_at'] : undefined;
    const weekStarts =
      typeof body['week_starts_at'] === 'string' ? body['week_starts_at'] : undefined;

    if (weeklyLimit === undefined && used === undefined && !resets) {
      return undefined;
    }

    const limit = weeklyLimit ?? this.lastKnownQuota?.weekly_limit ?? 0;
    return {
      weekly_limit: limit,
      limit: typeof body['limit'] === 'number' ? body['limit'] : limit,
      used: used ?? this.lastKnownQuota?.used ?? limit,
      remaining: 0,
      week_starts_at: weekStarts ?? this.lastKnownQuota?.week_starts_at ?? '',
      resets_at: resets ?? this.lastKnownQuota?.resets_at ?? ''
    };
  }

  private async formatInvokeError(error: unknown): Promise<string> {
    const parsed = await this.parseHttpError(error);
    return parsed.message;
  }

  private isQuotaExceededPayload(
    data: InterviewStartSuccess | InterviewQuotaExceeded | null
  ): data is InterviewQuotaExceeded {
    return Boolean(
      data &&
        typeof data === 'object' &&
        'code' in data &&
        data.code === 'WEEKLY_QUOTA_EXCEEDED'
    );
  }
}
