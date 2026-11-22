'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDb, createStore } = require('./lib/db');
const T = require('./lib/time');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 3000,
    dbPath: env.DB_PATH || path.join(__dirname, 'data', 'booking.db'),
    adminPassword: env.ADMIN_PASSWORD || 'admin1234',
    timeZone: env.TIMEZONE || 'Asia/Taipei',
    schoolName: env.SCHOOL_NAME || '我的教室',
    cancelHours: env.CANCEL_HOURS !== undefined ? Number(env.CANCEL_HOURS) : 2,
    bookCutoffMinutes: env.BOOK_CUTOFF_MINUTES !== undefined ? Number(env.BOOK_CUTOFF_MINUTES) : 0,
    bookAheadDays: Number(env.BOOK_AHEAD_DAYS) || 28,
  };
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const str = (v, max, field, { required = true } = {}) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw new HttpError(400, `請填寫${field}`);
  if (s.length > max) throw new HttpError(400, `${field}太長（最多 ${max} 字）`);
  return s;
};
const int = (v, min, max, field) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${field}需為 ${min}–${max} 的整數`);
  return n;
};
const normPhone = (v) => {
  const p = String(v ?? '').replace(/[^\d+]/g, '');
  if (!/^\+?\d{8,15}$/.test(p)) throw new HttpError(400, '請輸入正確的電話號碼');
  return p;
};

function createApp(cfg) {
  const db = openDb(cfg.dbPath);
  const store = createStore(db);
  const sessions = new Map(); // token -> expiresAt
  const SESSION_MS = 12 * 3600 * 1000;
  const loginFails = new Map(); // ip -> {count, until}

  const now = () => T.nowLocal(cfg.timeZone);
  const isOpen = (slot) => T.minutesBetween(now(), slot.start_at) > cfg.bookCutoffMinutes;
  const canCancel = (slot) => T.minutesBetween(now(), slot.start_at) >= cfg.cancelHours * 60;

  const publicSlot = (s) => ({
    id: s.id, title: s.title, startAt: s.start_at, durationMin: s.duration_min,
    capacity: s.capacity, booked: s.booked, remaining: Math.max(0, s.capacity - s.booked),
    note: s.note, open: isOpen(s),
  });

  function parseSlotInput(b) {
    const date = b.date, time = b.time;
    if (!T.isValidDate(date)) throw new HttpError(400, '日期格式錯誤');
    if (!T.isValidTime(time)) throw new HttpError(400, '時間格式錯誤');
    return {
      title: str(b.title, 60, '課程名稱'),
      startAt: `${date}T${time}`,
      duration: int(b.duration, 5, 600, '課程長度（分鐘）'),
      capacity: int(b.capacity, 1, 500, '名額'),
      note: str(b.note, 300, '備註', { required: false }),
    };
  }

  function requireAdmin(req) {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
    const exp = m && sessions.get(m[1]);
    if (!exp || exp < Date.now()) {
      if (m) sessions.delete(m[1]);
      throw new HttpError(401, '請先登入');
    }
  }

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  // ---------- 公開 API ----------
  route('GET', /^\/api\/config$/, () => ({
    schoolName: cfg.schoolName, cancelHours: cfg.cancelHours, bookAheadDays: cfg.bookAheadDays,
    timeZone: cfg.timeZone, now: now(),
  }));

  route('GET', /^\/api\/slots$/, (req, url) => {
    const today = now().slice(0, 10);
    let from = url.searchParams.get('from') || today;
    if (!T.isValidDate(from)) throw new HttpError(400, '日期格式錯誤');
    if (from < today) from = today;
    const days = Math.min(Number(url.searchParams.get('days')) || 7, 62);
    const lastDay = T.addDays(today, cfg.bookAheadDays);
    let to = T.addDays(from, days);
    if (to > lastDay) to = lastDay;
    if (from >= to) return { slots: [] };
    return { slots: store.listSlots(from + 'T00:00', to + 'T00:00').filter(isOpen).map(publicSlot) };
  });

  route('POST', /^\/api\/bookings$/, (req, url, body) => {
    const slotId = int(body.slotId, 1, Number.MAX_SAFE_INTEGER, '課程');
    const name = str(body.name, 40, '姓名');
    const phone = normPhone(body.phone);
    const note = str(body.note, 200, '備註', { required: false });
    const slot = store.getSlot(slotId);
    if (slot && slot.start_at.slice(0, 10) > T.addDays(now().slice(0, 10), cfg.bookAheadDays)) {
      throw new HttpError(409, '這堂課尚未開放預約');
    }
    const r = store.book({ slotId, name, phone, note, isOpen });
    if (r.error) throw new HttpError(r.status, r.error);
    return { status: 201, body: { code: r.booking.code, name: r.booking.name, slot: publicSlot(r.slot) } };
  });

  route('GET', /^\/api\/bookings$/, (req, url) => {
    const phone = normPhone(url.searchParams.get('phone'));
    const since = T.addDays(now().slice(0, 10), -1) + 'T00:00';
    return {
      bookings: store.bookingsByPhone(phone, since).map((b) => ({
        name: b.name, status: b.status, title: b.title, startAt: b.start_at, durationMin: b.duration_min,
        note: b.slot_note, past: b.start_at <= now(),
        cancellable: b.status === 'active' && canCancel(b),
        codeHint: b.code.slice(0, 2) + '••••',
      })),
    };
  });

  route('POST', /^\/api\/bookings\/cancel$/, (req, url, body) => {
    const phone = normPhone(body.phone);
    const code = str(body.code, 12, '預約代碼').toUpperCase();
    const b = store.getBookingByCode(code);
    if (!b || b.phone !== phone) throw new HttpError(404, '找不到這筆預約，請確認電話與預約代碼');
    if (b.status !== 'active') throw new HttpError(409, '這筆預約已經取消了');
    const slot = store.getSlot(b.slot_id);
    if (!canCancel(slot)) throw new HttpError(409, `上課前 ${cfg.cancelHours} 小時內無法線上取消，請直接聯絡老師`);
    store.cancelBooking(b.id);
    return { ok: true };
  });

  // ---------- 老師後台 API ----------
  route('POST', /^\/api\/admin\/login$/, (req, url, body) => {
    const ip = req.socket.remoteAddress || '';
    const f = loginFails.get(ip);
    if (f && f.until > Date.now()) throw new HttpError(429, '嘗試次數過多，請稍後再試');
    const a = crypto.createHash('sha256').update(String(body.password ?? '')).digest();
    const b = crypto.createHash('sha256').update(cfg.adminPassword).digest();
    if (!crypto.timingSafeEqual(a, b)) {
      const count = (f?.count || 0) + 1;
      loginFails.set(ip, { count, until: count >= 5 ? Date.now() + 5 * 60000 : 0 });
      throw new HttpError(401, '密碼錯誤');
    }
    loginFails.delete(ip);
    const token = crypto.randomBytes(24).toString('base64url');
    sessions.set(token, Date.now() + SESSION_MS);
    return { token };
  });

  route('POST', /^\/api\/admin\/logout$/, (req) => {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
    if (m) sessions.delete(m[1]);
    return { ok: true };
  });

  route('GET', /^\/api\/admin\/slots$/, (req, url) => {
    requireAdmin(req);
    const from = url.searchParams.get('from') || now().slice(0, 10);
    const to = url.searchParams.get('to') || T.addDays(from, 14);
    if (!T.isValidDate(from) || !T.isValidDate(to)) throw new HttpError(400, '日期格式錯誤');
    const slots = store.listSlots(from + 'T00:00', to + 'T00:00');
    return {
      now: now(),
      slots: slots.map((s) => ({
        ...publicSlot(s),
        bookings: store.slotBookings(s.id).map((b) => ({
          id: b.id, name: b.name, phone: b.phone, note: b.note, code: b.code,
          status: b.status, createdAt: b.created_at,
        })),
      })),
    };
  });

  route('POST', /^\/api\/admin\/slots$/, (req, url, body) => {
    requireAdmin(req);
    const id = store.createSlot(parseSlotInput(body));
    return { status: 201, body: { id } };
  });

  route('POST', /^\/api\/admin\/slots\/batch$/, (req, url, body) => {
    requireAdmin(req);
    const { startDate, endDate } = body;
    if (!T.isValidDate(startDate) || !T.isValidDate(endDate)) throw new HttpError(400, '日期格式錯誤');
    if (endDate < startDate) throw new HttpError(400, '結束日期不能早於開始日期');
    if (T.minutesBetween(startDate + 'T00:00', endDate + 'T00:00') > 366 * 1440) throw new HttpError(400, '一次最多建立一年內的課程');
    const weekdays = Array.isArray(body.weekdays) ? body.weekdays.map(Number).filter((d) => d >= 0 && d <= 6) : [];
    if (!weekdays.length) throw new HttpError(400, '請至少選擇一個星期');
    const times = Array.isArray(body.times) ? body.times : [body.time];
    if (!times.length || !times.every(T.isValidTime)) throw new HttpError(400, '時間格式錯誤');
    const base = parseSlotInput({ ...body, date: startDate, time: times[0] });
    const items = [];
    for (let d = startDate; d <= endDate; d = T.addDays(d, 1)) {
      if (!weekdays.includes(T.weekday(d))) continue;
      for (const t of times) items.push({ ...base, startAt: `${d}T${t}` });
    }
    if (!items.length) throw new HttpError(400, '這段期間沒有符合的日期');
    if (items.length > 500) throw new HttpError(400, '一次最多建立 500 堂課');
    const ids = store.createSlots(items);
    return { status: 201, body: { created: ids.length } };
  });

  route('PUT', /^\/api\/admin\/slots\/(\d+)$/, (req, url, body, [, id]) => {
    requireAdmin(req);
    const slot = store.getSlot(Number(id));
    if (!slot) throw new HttpError(404, '找不到這堂課');
    const input = parseSlotInput(body);
    if (input.capacity < slot.booked) throw new HttpError(409, `已有 ${slot.booked} 人預約，名額不能少於這個數字`);
    store.updateSlot(slot.id, input);
    return { ok: true };
  });

  route('DELETE', /^\/api\/admin\/slots\/(\d+)$/, (req, url, body, [, id]) => {
    requireAdmin(req);
    if (!store.deleteSlot(Number(id))) throw new HttpError(404, '找不到這堂課');
    return { ok: true };
  });

  route('POST', /^\/api\/admin\/bookings\/(\d+)\/cancel$/, (req, url, body, [, id]) => {
    requireAdmin(req);
    const b = store.getBooking(Number(id));
    if (!b) throw new HttpError(404, '找不到這筆預約');
    if (!store.cancelBooking(b.id)) throw new HttpError(409, '這筆預約已經取消了');
    return { ok: true };
  });

  // 老師幫學生代約（不受截止時間限制，但仍檢查名額）
  route('POST', /^\/api\/admin\/slots\/(\d+)\/bookings$/, (req, url, body, [, id]) => {
    requireAdmin(req);
    const r = store.book({
      slotId: Number(id), name: str(body.name, 40, '姓名'), phone: normPhone(body.phone),
      note: str(body.note, 200, '備註', { required: false }), isOpen: () => true,
    });
    if (r.error) throw new HttpError(r.status, r.error);
    return { status: 201, body: { code: r.booking.code } };
  });

  // ---------- HTTP 處理 ----------
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 64 * 1024) { reject(new HttpError(413, '資料太大')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!size) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new HttpError(400, '資料格式錯誤')); }
      });
      req.on('error', reject);
    });
  }

  function send(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(body);
  }

  function serveStatic(req, res, pathname) {
    if (pathname === '/') pathname = '/index.html';
    else if (pathname === '/admin' || pathname === '/my') pathname += '.html';
    const file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('找不到頁面'); }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method Not Allowed');
        return serveStatic(req, res, url.pathname);
      }
      let matchedPath = false;
      for (const r of routes) {
        const m = r.pattern.exec(url.pathname);
        if (!m) continue;
        matchedPath = true;
        if (r.method !== req.method) continue;
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '資料格式錯誤');
        const out = r.handler(req, url, body, m);
        if (out && out.status) return send(res, out.status, out.body);
        return send(res, 200, out);
      }
      throw new HttpError(matchedPath ? 405 : 404, matchedPath ? 'Method Not Allowed' : '找不到這個 API');
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e);
      return send(res, 500, { error: '伺服器發生錯誤，請稍後再試' });
    }
  }

  const server = http.createServer(handle);
  server.on('close', () => db.close());
  return server;
}

if (require.main === module) {
  const cfg = loadConfig();
  if (!process.env.ADMIN_PASSWORD) {
    console.warn('⚠️  尚未設定 ADMIN_PASSWORD，目前後台密碼為預設值 admin1234，正式使用前請務必修改！');
  }
  createApp(cfg).listen(cfg.port, () => {
    console.log(`✅ 約課系統已啟動：http://localhost:${cfg.port}`);
    console.log(`   老師後台：http://localhost:${cfg.port}/admin`);
  });
}

module.exports = { createApp, loadConfig };
