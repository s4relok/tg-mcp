function partsInTimeZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  const values = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') {
      values[part.type] = part.value;
    }
  }

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
  };
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = partsInTimeZone(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );

  return asUtc - date.getTime();
}

export function zonedTimeToUtc(dateText, timeZone) {
  const [datePart, timePart = '00:00:00'] = dateText.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour = 0, minute = 0, second = 0] = timePart.split(':').map(Number);
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const offset = getTimeZoneOffsetMs(guess, timeZone);
  return new Date(guess.getTime() - offset);
}

export function todayInTimeZone(timeZone) {
  const parts = partsInTimeZone(new Date(), timeZone);
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return `${parts.year}-${month}-${day}`;
}

export function dayRange(date, timeZone) {
  const day = date || todayInTimeZone(timeZone);
  const start = zonedTimeToUtc(`${day}T00:00:00`, timeZone);
  const [year, month, dayOfMonth] = day.split('-').map(Number);
  const nextLocalMidnight = new Date(Date.UTC(year, month - 1, dayOfMonth) + 24 * 60 * 60 * 1000);
  const endDay = nextLocalMidnight.toISOString().slice(0, 10);
  const end = zonedTimeToUtc(`${endDay}T00:00:00`, timeZone);
  return { date: day, from: start, to: end };
}

export function normalizePeriod({ from, to, timezone }) {
  if (!from || !to) {
    throw new Error('from and to are required for period summaries');
  }

  return {
    from: zonedTimeToUtc(`${from}T00:00:00`, timezone),
    to: zonedTimeToUtc(`${to}T00:00:00`, timezone)
  };
}
