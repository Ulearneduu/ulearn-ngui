import type { InterviewUsageRow } from '../../../models';

export const USAGE_CSV_HEADERS = [
  'Session ID',
  'Student ID',
  'College',
  'Batch',
  'Template',
  'Interview type',
  'Started at',
  'Completed at',
  'Status',
  'Elapsed seconds',
  'Input tokens',
  'Output tokens',
  'Total tokens',
  'Provider',
  'Model',
  'Estimated cost',
  'Currency',
  'AI score (0-100)',
] as const;

const PRIVATE_HEADERS = ['resume', 'transcript', 'password', 'access token', 'secret'];

export function usageCsv(rows: readonly InterviewUsageRow[]): string {
  const lines = [USAGE_CSV_HEADERS.join(',')];
  for (const row of rows) {
    lines.push(USAGE_CSV_HEADERS.map((header) => csvCell(cellValue(row, header))).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

function cellValue(row: InterviewUsageRow, header: (typeof USAGE_CSV_HEADERS)[number]): string | number | null {
  switch (header) {
    case 'Session ID':
      return row.sessionId;
    case 'Student ID':
      return row.studentId;
    case 'College':
      return row.collegeName;
    case 'Batch':
      return row.batchNames;
    case 'Template':
      return row.templateTitle;
    case 'Interview type':
      return row.templateKind;
    case 'Started at':
      return row.startedAt;
    case 'Completed at':
      return row.endedAt;
    case 'Status':
      return row.status;
    case 'Elapsed seconds':
      return row.elapsedSeconds;
    case 'Input tokens':
      return row.inputTokens;
    case 'Output tokens':
      return row.outputTokens;
    case 'Total tokens':
      return row.totalTokens;
    case 'Provider':
      return row.provider;
    case 'Model':
      return row.model;
    case 'Estimated cost':
      return row.estimatedCost;
    case 'Currency':
      return row.currency;
    case 'AI score (0-100)':
      return row.score;
    default:
      return null;
  }
}

export function usageCsvExposesPrivateText(csv: string): boolean {
  const header = csv.split('\r\n')[0]?.replace(/^\uFEFF/, '').toLowerCase() ?? '';
  return PRIVATE_HEADERS.some((name) => header.includes(name));
}
