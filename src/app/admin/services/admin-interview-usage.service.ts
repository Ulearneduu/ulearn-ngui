import { Injectable } from '@angular/core';
import { supabase } from '../../core/supabase.client';
import type {
  InterviewUsageCostStatus,
  InterviewUsageFilters,
  InterviewUsageReport,
  InterviewUsageRow,
  InterviewUsageSummary,
} from '../../models';

export interface InterviewUsageQuery {
  from: string;
  to: string;
  college: string | null;
  batchId: string | null;
  status: string | null;
  templateId: string | null;
  limit: number;
  offset: number;
}

const COST_STATUSES: InterviewUsageCostStatus[] = [
  'estimated',
  'unavailable',
  'unconfigured',
  'mixed',
  'none',
  'no_usage',
];

@Injectable({ providedIn: 'root' })
export class AdminInterviewUsageService {
  async filters(): Promise<InterviewUsageFilters> {
    const { data, error } = await supabase.rpc('interview_usage_filters');
    if (error) throw new Error(usageErrorMessage(error.message));
    return parseFilters(data);
  }

  async report(query: InterviewUsageQuery): Promise<InterviewUsageReport> {
    const { data, error } = await supabase.rpc('interview_usage_report', {
      p_from: query.from,
      p_to: query.to,
      p_college: query.college,
      p_batch: query.batchId,
      p_status: query.status,
      p_template_id: query.templateId,
      p_limit: query.limit,
      p_offset: query.offset,
    });
    if (error) throw new Error(usageErrorMessage(error.message));
    return parseReport(data);
  }
}

export function usageErrorMessage(message: string): string {
  const text = message.toLowerCase();
  if (text.includes('forbidden') || text.includes('42501')) {
    return 'You do not have access to interview usage analytics.';
  }
  if (text.includes('unauthenticated') || text.includes('28000')) {
    return 'Sign in again to view interview usage analytics.';
  }
  if (text.includes('invalid period') || text.includes('period too long')) {
    return 'Choose a valid date range of 800 days or less.';
  }
  return 'Could not load interview usage analytics.';
}

function parseFilters(value: unknown): InterviewUsageFilters {
  const record = asRecord(value);
  return {
    colleges: stringList(record['colleges']),
    unassignedCollege: record['unassignedCollege'] === true,
    batches: objectList(record['batches']).flatMap((item) => {
      const id = text(item['id']);
      const name = text(item['name']);
      return id && name ? [{ id, name }] : [];
    }),
    unassignedBatch: record['unassignedBatch'] === true,
    templates: objectList(record['templates']).flatMap((item) => {
      const id = text(item['id']);
      const title = text(item['title']);
      if (!id || !title) return [];
      return [{ id, title, kind: text(item['kind']) }];
    }),
    pricingConfigured: record['pricingConfigured'] === true,
  };
}

function parseReport(value: unknown): InterviewUsageReport {
  const record = asRecord(value);
  const summary = asRecord(record['summary']);
  const page = asRecord(record['page']);
  const costStatus = cost(summary['costStatus']);
  return {
    summary: {
      sessionsStarted: count(summary['sessionsStarted']),
      sessionsCompleted: count(summary['sessionsCompleted']),
      completionRate: numberOrNull(summary['completionRate']),
      averageScore: numberOrNull(summary['averageScore']),
      scoredSessions: count(summary['scoredSessions']),
      scoreScale: text(summary['scoreScale']) ?? '0-100',
      uniqueStudents: count(summary['uniqueStudents']),
      inputTokens: numberOrNull(summary['inputTokens']),
      outputTokens: numberOrNull(summary['outputTokens']),
      totalTokens: numberOrNull(summary['totalTokens']),
      knownCalls: count(summary['knownCalls']),
      unknownCalls: count(summary['unknownCalls']),
      sessionsMissingUsage: count(summary['sessionsMissingUsage']),
      estimatedCost: text(summary['estimatedCost']),
      currency: text(summary['currency']),
      costStatus,
      usageIncomplete: summary['usageIncomplete'] === true,
      durationBasis: 'elapsed_start_to_end',
      averageElapsedSeconds: numberOrNull(summary['averageElapsedSeconds']),
      totalElapsedSeconds: numberOrNull(summary['totalElapsedSeconds']),
      sessionsWithEnd: count(summary['sessionsWithEnd']),
      sessionsWithoutEnd: count(summary['sessionsWithoutEnd']),
      periodFrom: text(summary['periodFrom']) ?? '',
      periodTo: text(summary['periodTo']) ?? '',
    } satisfies InterviewUsageSummary,
    page: {
      offset: count(page['offset']),
      limit: count(page['limit']),
      total: count(page['total']),
    },
    rows: objectList(record['rows']).map(parseRow),
  };
}

function parseRow(value: Record<string, unknown>): InterviewUsageRow {
  const usageState = value['usageState'];
  return {
    sessionId: text(value['sessionId']) ?? '',
    studentId: text(value['studentId']) ?? '',
    collegeName: text(value['collegeName']),
    batchNames: text(value['batchNames']),
    templateTitle: text(value['templateTitle']) ?? 'Interview',
    templateKind: text(value['templateKind']),
    startedAt: text(value['startedAt']) ?? '',
    endedAt: text(value['endedAt']),
    status: text(value['status']) ?? '',
    elapsedSeconds: numberOrNull(value['elapsedSeconds']),
    inputTokens: numberOrNull(value['inputTokens']),
    outputTokens: numberOrNull(value['outputTokens']),
    totalTokens: numberOrNull(value['totalTokens']),
    usageState: usageState === 'known' || usageState === 'unknown' || usageState === 'partial' ? usageState : 'none',
    provider: text(value['provider']),
    model: text(value['model']),
    estimatedCost: text(value['estimatedCost']),
    currency: text(value['currency']),
    costStatus: cost(value['costStatus']),
    score: numberOrNull(value['score']),
    lastUsageAt: text(value['lastUsageAt']),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function objectList(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const label = text(item);
    return label ? [label] : [];
  });
}

function text(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value;
  return null;
}

function count(value: unknown): number {
  const parsed = numberOrNull(value);
  return parsed === null ? 0 : parsed;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function cost(value: unknown): InterviewUsageCostStatus {
  return COST_STATUSES.find((status) => status === value) ?? 'unavailable';
}
