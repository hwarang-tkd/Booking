'use strict';
// 所有課程時間都以「當地時間字串」 'YYYY-MM-DDTHH:MM' 儲存，
// 比較或加減時把它當成 UTC 解析，就不會受伺服器所在時區影響。

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function nowLocal(timeZone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
}

const toMs = (local) => Date.parse(local + ':00Z');
const fromMs = (ms) => new Date(ms).toISOString().slice(0, 16);

function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  return fromMs(toMs(s + 'T00:00')).slice(0, 10) === s; // 排除 2月30日 之類
}

function isValidTime(s) {
  return typeof s === 'string' && TIME_RE.test(s);
}

function addDays(dateStr, n) {
  return fromMs(toMs(dateStr + 'T00:00') + n * 86400000).slice(0, 10);
}

function weekday(dateStr) {
  return new Date(toMs(dateStr + 'T00:00')).getUTCDay(); // 0 = 週日
}

function minutesBetween(fromLocal, toLocal) {
  return (toMs(toLocal) - toMs(fromLocal)) / 60000;
}

module.exports = { LOCAL_RE, nowLocal, isValidDate, isValidTime, addDays, weekday, minutesBetween, toMs, fromMs };
