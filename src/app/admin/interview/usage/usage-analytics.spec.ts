import assert from 'node:assert/strict';
import test from 'node:test';
import type { InterviewUsageRow } from '../../../models/index.ts';
import { csvCell, usageCsv, usageCsvExposesPrivateText, USAGE_CSV_HEADERS } from './usage-csv.ts';
import { formatEstimatedCost, formatTokenCount } from './usage-format.ts';
import { localDayRange } from './usage-period.ts';

const row: InterviewUsageRow = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  studentId: '22222222-2222-4222-8222-222222222222',
  collegeName: 'Alpha, "Main"',
  batchNames: 'CSE 2027',
  templateTitle: 'HR Behavioral',
  templateKind: 'hr',
  startedAt: '2026-11-01T02:30:00.000Z',
  endedAt: null,
  status: 'in_progress',
  elapsedSeconds: null,
  inputTokens: 12,
  outputTokens: null,
  totalTokens: null,
  usageState: 'partial',
  provider: 'openai',
  model: 'gpt-6-luna',
  estimatedCost: null,
  currency: null,
  costStatus: 'unconfigured',
  score: null,
  lastUsageAt: null,
};

test('csv headers and rows keep nulls blank and quote special text', () => {
  const csv = usageCsv([
    row,
    {
      ...row,
      sessionId: '33333333-3333-4333-8333-333333333333',
      collegeName: 'Line\nBreak',
      batchNames: '=cmd',
      templateTitle: '你好',
      estimatedCost: '1.25',
      currency: 'USD',
      costStatus: 'estimated',
      score: 88.5,
      endedAt: '2026-11-01T03:00:00.000Z',
      elapsedSeconds: 1800,
      outputTokens: 4,
      totalTokens: 16,
    },
  ]);
  const lines = csv.replace(/^\uFEFF/, '').trim().split('\r\n');
  assert.equal(lines[0], USAGE_CSV_HEADERS.join(','));
  assert.match(lines[1] ?? '', /"Alpha, ""Main"""/);
  assert.equal(lines[1]?.includes('resume'), false);
  assert.match(lines[2] ?? '', /'=cmd/);
  assert.match(lines[2] ?? '', /"Line\nBreak"/);
  assert.match(lines[2] ?? '', /你好/);
  assert.match(lines[2] ?? '', /,1\.25,USD,88\.5/);
  assert.equal(usageCsvExposesPrivateText(csv), false);
  assert.equal(csvCell(null), '');
  assert.equal(csvCell('=1+1'), "'=1+1");
});

test('missing cost is not displayed as zero', () => {
  assert.equal(formatEstimatedCost(null, null, 'unconfigured'), 'Unavailable — pricing not configured');
  assert.equal(formatEstimatedCost(null, null, 'unavailable'), 'Unavailable');
  assert.equal(formatEstimatedCost(null, null, 'mixed'), 'Unavailable — mixed currencies');
  assert.equal(formatEstimatedCost('0.000000', 'USD', 'estimated'), '0 USD estimated');
  assert.equal(formatTokenCount(null), 'Unavailable');
  assert.equal(formatTokenCount(0), '0');
});

test('local date ranges are inclusive of the end date and reject an inverted range', () => {
  const range = localDayRange('2026-11-01', '2026-11-01');
  assert.ok(range);
  const from = new Date(range.from);
  const to = new Date(range.to);
  assert.equal(from.getFullYear(), 2026);
  assert.equal(from.getMonth(), 10);
  assert.equal(from.getDate(), 1);
  assert.equal(from.getHours(), 0);
  assert.equal(to.getFullYear(), 2026);
  assert.equal(to.getMonth(), 10);
  assert.equal(to.getDate(), 2);
  assert.equal(to.getHours(), 0);
  assert.equal(localDayRange('2026-11-02', '2026-11-01'), null);
  assert.equal(localDayRange('2026-02-31', '2026-03-01'), null);
});
