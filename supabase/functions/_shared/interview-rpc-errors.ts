/**
 * Maps PostgREST / Supabase JS RPC errors to HTTP responses for interview Edge Functions.
 *
 * PostgREST typically exposes PostgreSQL failures as:
 * - `message`: human-readable text (often includes SQLSTATE prefix, e.g. "42501: ...")
 * - `code`: sometimes the five-char SQLSTATE, sometimes a PostgREST code (e.g. "PGRST...")
 * - `details`: optional extra context
 *
 * Message substring checks are intentional fallbacks when `code` is not a SQLSTATE.
 */

export type RpcErrorLike = {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
};

export type InterviewRpcErrorKind =
  | 'auth'
  | 'permission'
  | 'not_found'
  | 'config'
  | 'server';

export function sqlStateFromRpcError(err: RpcErrorLike): string | null {
  const code = err.code?.trim() ?? '';
  if (/^\d{5}$/.test(code)) {
    return code;
  }
  const fromMessage = err.message?.match(/^(\d{5}):/);
  if (fromMessage?.[1]) {
    return fromMessage[1];
  }
  const fromDetails = err.details?.match(/^(\d{5})/);
  if (fromDetails?.[1]) {
    return fromDetails[1];
  }
  return null;
}

export function classifyInterviewRpcError(err: RpcErrorLike): InterviewRpcErrorKind {
  const sqlState = sqlStateFromRpcError(err);
  const haystack = `${err.message ?? ''} ${err.details ?? ''}`.toLowerCase();

  if (sqlState === '28000' || haystack.includes('authentication required')) {
    return 'auth';
  }
  if (
    sqlState === '42501' ||
    haystack.includes('interview access denied') ||
    haystack.includes('quota management denied')
  ) {
    return 'permission';
  }
  if (
    sqlState === 'P0002' ||
    haystack.includes('not resumable') ||
    haystack.includes('not found')
  ) {
    return 'not_found';
  }
  if (
    sqlState === '22023' ||
    haystack.includes('configuration is missing') ||
    haystack.includes('weekly limit must be')
  ) {
    return 'config';
  }
  return 'server';
}

export function interviewRpcHttpStatus(err: RpcErrorLike): number {
  switch (classifyInterviewRpcError(err)) {
    case 'auth':
      return 401;
    case 'permission':
      return 403;
    case 'not_found':
      return 404;
    case 'config':
      return 503;
    default:
      return 500;
  }
}

export function interviewStartRpcErrorMessage(
  err: RpcErrorLike,
  status: number,
): string {
  if (status === 401) return 'Unauthorized';
  if (status === 403) return 'Interview access denied.';
  if (status === 404) return 'Interview session not found or not resumable.';
  if (status === 503) {
    return 'Interview quota is temporarily unavailable. Please try again later.';
  }
  return 'Could not start interview. Please try again.';
}

export function interviewQuotaStatusRpcErrorMessage(
  err: RpcErrorLike,
  status: number,
): string {
  if (status === 401) return 'Unauthorized';
  if (status === 403) return 'Interview access denied.';
  if (status === 503) {
    return 'Interview quota is temporarily unavailable. Please try again later.';
  }
  return 'Could not load interview quota. Please try again.';
}
