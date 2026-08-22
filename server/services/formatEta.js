/**
 * Format an ETA given in seconds into a human readable string.
 * Supports hours, minutes and seconds, e.g. "1h 5m 30s", "5m 30s", "30s".
 * @param {number} seconds
 * @returns {string}
 */
function formatEta(seconds) {
  if (seconds === null || seconds === undefined || isNaN(seconds)) return '';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

module.exports = { formatEta };
