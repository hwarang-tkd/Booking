// 共用工具：API 呼叫、日期格式化、小工具
const DOW = ['日', '一', '二', '三', '四', '五', '六'];

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw Object.assign(new Error('網路連線失敗，請稍後再試'), { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || '發生錯誤'), { status: res.status });
  return data;
}

// 'YYYY-MM-DDTHH:MM' 皆為教室當地時間，用 UTC 運算避免瀏覽器時區干擾
const toMs = (local) => Date.parse(local + ':00Z');
const pad = (n) => String(n).padStart(2, '0');
function addDays(dateStr, n) {
  return new Date(toMs(dateStr + 'T00:00') + n * 86400000).toISOString().slice(0, 10);
}
function dow(dateStr) { return new Date(toMs(dateStr + 'T00:00')).getUTCDay(); }
function fmtDate(dateStr) {
  const [, m, d] = dateStr.split('-');
  return `${Number(m)}/${Number(d)}（${DOW[dow(dateStr)]}）`;
}
function endTime(startAt, durationMin) {
  const d = new Date(toMs(startAt) + durationMin * 60000);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
function fmtSlot(s) {
  return `${fmtDate(s.startAt.slice(0, 10))} ${s.startAt.slice(11)}–${endTime(s.startAt, s.durationMin)}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function store(key, val) {
  try {
    if (val === undefined) return JSON.parse(localStorage.getItem(key) ?? 'null');
    localStorage.setItem(key, JSON.stringify(val));
  } catch { return null; }
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast'; el.setAttribute('role', 'status'); el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function showError(el, msg) {
  el.textContent = msg; el.className = 'alert error'; el.classList.remove('hidden');
}

// 課程分類顏色
let CATS = {};
const catColor = (id) => (CATS[id] || CATS.other || {}).color || '#ddd';
const catName = (id) => (CATS[id] || {}).name || '';
const catStyle = (id) => `--cat:${catColor(id)}`;

async function applyConfig() {
  const cfg = await api('/api/config');
  CATS = Object.fromEntries(cfg.categories.map((c) => [c.id, c]));
  document.querySelectorAll('[data-school]').forEach((el) => { el.textContent = cfg.schoolName; });
  const foot = document.querySelector('footer.site');
  if (foot && cfg.address) {
    foot.innerHTML = `${esc(cfg.schoolName)}・${esc(cfg.address)}${cfg.addressNote ? `<br>${esc(cfg.addressNote)}` : ''}` +
      (cfg.facebookUrl ? `<br><a href="${esc(cfg.facebookUrl)}" target="_blank" rel="noopener">Facebook 粉絲專頁</a>` : '');
  }
  document.title = `${document.title}｜${cfg.schoolName}`;
  return cfg;
}
