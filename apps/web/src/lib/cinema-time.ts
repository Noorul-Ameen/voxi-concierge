/** Vista's zone-less timestamps are Dubai wall time, never the browser's local time. */
export function cinemaDate(showtime: string): Date {
  const localTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;
  return new Date(localTimestamp.test(showtime) ? `${showtime}+04:00` : showtime);
}
