/** A moment as it reads on this PC, in its local time. */
export function formatDateTime(iso: string, withSeconds = false) {
  const date = new Date(iso);
  if (Number.isNaN(+date)) return '';
  return date.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    hour: 'numeric', minute: '2-digit', second: withSeconds ? '2-digit' : undefined,
  });
}

export const fmtDateTime = (iso: string) => formatDateTime(iso);
