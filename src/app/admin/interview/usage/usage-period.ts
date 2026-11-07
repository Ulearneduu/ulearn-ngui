/** Inclusive local calendar dates. `to` is the exclusive UTC instant of the next local midnight. */
export function localDayRange(fromDate: string, toDate: string): { from: string; to: string } | null {
  const from = localMidnight(fromDate);
  const to = localMidnight(toDate);
  if (!from || !to || to.getTime() < from.getTime()) return null;
  const exclusive = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1, 0, 0, 0, 0);
  return { from: from.toISOString(), to: exclusive.toISOString() };
}

export function recentLocalDates(now: Date, days: number): { fromDate: string; toDate: string } {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (days - 1));
  return { fromDate: formatLocalDate(start), toDate: formatLocalDate(end) };
}

export function formatLocalDate(value: Date): string {
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

function localMidnight(isoDate: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}
