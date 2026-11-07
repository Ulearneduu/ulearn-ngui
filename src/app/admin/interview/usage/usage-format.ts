import type { InterviewUsageCostStatus } from '../../../models';

export function formatEstimatedCost(
  amount: string | null,
  currency: string | null,
  status: InterviewUsageCostStatus
): string {
  if (status === 'estimated' && amount !== null && currency) {
    return `${trimCost(amount)} ${currency} estimated`;
  }
  if (status === 'unconfigured') return 'Unavailable — pricing not configured';
  if (status === 'mixed') return 'Unavailable — mixed currencies';
  if (status === 'none') return '—';
  return 'Unavailable';
}

export function formatTokenCount(value: number | null): string {
  if (value === null) return 'Unavailable';
  return value.toLocaleString('en-US');
}

export function formatElapsed(seconds: number | null): string {
  if (seconds === null) return '—';
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const remain = whole % 60;
  if (minutes === 0) return `${remain}s`;
  return `${minutes}m ${remain}s`;
}

export function formatRate(value: number | null): string {
  if (value === null) return '—';
  return `${value}%`;
}

export function formatScore(value: number | null): string {
  if (value === null) return '—';
  return String(value);
}

function trimCost(amount: string): string {
  if (!amount.includes('.')) return amount;
  return amount.replace(/\.?0+$/, '');
}
