const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatDateTime(value, {
  fallback = '',
  useCurrentTime = false,
} = {}) {
  const date = value ? new Date(value) : useCurrentTime ? new Date() : null;
  if (!date || Number.isNaN(date.getTime())) return fallback;
  return DATE_TIME_FORMATTER.format(date).replaceAll('/', '.');
}
