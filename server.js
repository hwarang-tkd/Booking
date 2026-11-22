'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDb, createStore, passStatus } = require('./lib/db');
const { CATEGORIES, CATEGORY_IDS, DEFAULT_TEMPLATES } = require('./lib/schedule');
const T = require('./lib/time');

// 自動讀取專案資料夾中的 .env（不會被上傳到 git）
const ENV_FILE = path.join(__dirname, '.env');
if (require.main === module && fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const PUBLIC_DIR = path.join(__dirname, 'public');
const PAGES = { '/': '/index.html', '/my': '/my.html', '/info': '/info.html', '/admin': '/admin.html' };
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

function loadConfig(env = process.env) {
  const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);
  return {
    port: num(env.PORT, 3000),
    dbPath: env.DB_PATH || path.join(__dirname, 'data', 'booking.db'),
    adminPassword: env.ADMIN_PASSWORD || '',
    timeZone: env.TIMEZONE || 'Asia/Taipei',
    schoolName: env.SCHOOL_NAME || '花郎武道館',
    address: env.SCHOOL_ADDRESS ?? '台北市忠孝東路一段176號2樓之1',
    addressNote: env.SCHOOL_ADDRESS_NOTE ?? '近善導寺捷運站 5 號出口',
    facebookUrl: env.FACEBOOK_URL || '',
    cancelHours: num(env.CANCEL_HOURS, 2),
    bookCutoffMinutes: num(env.BOOK_CUTOFF_MINUTES, 0),
    bookAheadDays: num(env.BOOK_AHEAD_DAYS, 28) || 28,
    seedSchedule: env.SEED_SCHEDULE !== '0',
    requirePass: env.REQUIRE_PASS !== '0', // 學員自己約課時需要有可用堂數
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
  if (!p) return '';
  if (!/^\+?\d{8,15}$/.test(p)) throw new HttpError(400, '請輸入正確的電話號碼');
  return p;
};
const normEmail = (v) => {
  const e = String(v ?? '').trim().toLowerCase();
  if (!e) throw new HttpError(400, '請輸入信箱');
  if (e.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new HttpError(400, `信箱格式不正確：${e}`);
  return e;
};
const category = (v) => (CATEGORY_IDS.includes(v) ? v : 'other');

function createApp(cfg) {
  const db = openDb(cfg.dbPath);
  const store = createStore(db);
  if (cfg.seedSchedule && store.isEmpty()) store.createTemplates(DEFAULT_TEMPLATES);

  const ADMIN_SESSION_MS = 12 * 3600 * 1000;
  const STUDENT_SESSION_MS = 180 * 86400 * 1000; // 學員登入一次可保持半年
  const loginFails = new Map(); // ip -> {count, until}

  function checkThrottle(req) {
    const f = loginFails.get(req.socket.remoteAddress || '');
    if (f && f.until > Date.now()) throw new HttpError(429, '嘗試次數過多，請稍後再試');
  }
  function recordFail(req, limit) {
    const ip = req.socket.remoteAddress || '';
    const count = (loginFails.get(ip)?.count || 0) + 1;
    loginFails.set(ip, { count, until: count >= limit ? Date.now() + 5 * 60000 : 0 });
  }

  const now = () => T.nowLocal(cfg.timeZone);
  const today = () => now().slice(0, 10);
  const isOpen = (slot) => !slot.cancelled && T.minutesBetween(now(), slot.start_at) > cfg.bookCutoffMinutes;
  const canCancel = (slot) => T.minutesBetween(now(), slot.start_at) >= cfg.cancelHours * 60;

  // 依固定課表自動補齊課程（同一天內只對新範圍做一次）
  let generated = { day: '', until: '' };
  function ensureGenerated(untilDate) {
    const d = today();
    const max = T.addDays(d, 120);
    if (untilDate > max) untilDate = max;
    if (generated.day === d && generated.until >= untilDate) return;
    const from = generated.day === d ? generated.until : d;
    const dates = [];
    for (let x = from; x < untilDate; x = T.addDays(x, 1)) dates.push({ date: x, weekday: T.weekday(x) });
    if (dates.length) store.generate(dates);
    generated = { day: d, until: untilDate };
  }
  const resetGenerated = () => { generated = { day: '', until: '' }; };

  const publicSlot = (s) => ({
    id: s.id, title: s.title, subtitle: s.subtitle, category: s.category, startAt: s.start_at,
    durationMin: s.duration_min, capacity: s.capacity, booked: s.booked,
    remaining: Math.max(0, s.capacity - s.booked), note: s.note, open: isOpen(s),
  });
  const publicTemplate = (t) => ({
    id: t.id, title: t.title, subtitle: t.subtitle, category: t.category, weekday: t.weekday, time: t.time,
    durationMin: t.duration_min, capacity: t.capacity, note: t.note,
  });

  function parseClassFields(b) {
    return {
      title: str(b.title, 60, '課程名稱'),
      subtitle: str(b.subtitle, 80, '副標題', { required: false }),
      category: category(b.category),
      duration: int(b.duration, 5, 600, '課程長度（分鐘）'),
      capacity: int(b.capacity, 1, 500, '名額'),
      note: str(b.note, 300, '備註', { required: false }),
    };
  }
  function parseSlotInput(b) {
    if (!T.isValidDate(b.date)) throw new HttpError(400, '日期格式錯誤');
    if (!T.isValidTime(b.time)) throw new HttpError(400, '時間格式錯誤');
    return { ...parseClassFields(b), startAt: `${b.date}T${b.time}` };
  }

  const bearer = (req) => (/^Bearer (\S+)$/.exec(req.headers.authorization || '') || [])[1];
  function requireAdmin(req) {
    const t = bearer(req);
    const s = t && store.getSession(t);
    if (!s || s.role !== 'admin') throw new HttpError(401, '請先登入');
  }
  /** 取得登入中的學員；required=false 時未登入回傳 null。 */
  function currentStudent(req, required = true) {
    const t = bearer(req);
    const s = t && store.getSession(t);
    const st = s && s.role === 'student' && store.getStudent(s.student_id);
    if (st && st.active) return st;
    if (required) throw new HttpError(401, '請先用信箱登入');
    return null;
  }
  const publicPass = (p) => ({
    id: p.id, name: p.name, total: p.total, used: p.used, remaining: Math.max(0, p.total - p.used),
    purchaseDate: p.purchase_date, startDate: p.start_date, endDate: p.end_date, categories: p.categories ? p.categories.split(',') : [],
    note: p.note, status: passStatus(p, today()),
  });
  function parsePass(b) {
    if (!T.isValidDate(b.startDate) || !T.isValidDate(b.endDate)) throw new HttpError(400, '請填寫正確的開始與到期日期');
    if (b.endDate < b.startDate) throw new HttpError(400, '到期日不能早於開始日');
    const purchaseDate = b.purchaseDate || today();
    if (!T.isValidDate(purchaseDate)) throw new HttpError(400, '購買日格式錯誤');
    if (purchaseDate > today()) throw new HttpError(400, '購買日不能晚於今天');
    const cats = Array.isArray(b.categories) ? b.categories.filter((c) => CATEGORY_IDS.includes(c)) : [];
    return {
      name: str(b.name, 40, '方案名稱'),
      total: int(b.total, 1, 500, '堂數'),
      startDate: b.startDate, endDate: b.endDate,
      categories: [...new Set(cats)].join(','),
      note: str(b.note, 200, '備註', { required: false }),
      purchaseDate,
    };
  }
  const publicStudent = (st) => ({ id: st.id, name: st.name, email: st.email, phone: st.phone });
  function parseStudent(b) {
    return {
      name: str(b.name, 40, '姓名'),
      email: normEmail(b.email),
      phone: normPhone(b.phone),
      note: str(b.note, 300, '備註', { required: false }),
      birthday: parseBirthday(b.birthday),
    };
  }
  function parseBirthday(v) {
    const raw = String(v ?? '').trim();
    if (!raw) return '';
    const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(raw);
    const d = m && `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    if (!d || !T.isValidDate(d) || d > today() || d < '1900-01-01') throw new HttpError(400, `生日格式不正確：${raw}（例如 2015-03-21）`);
    return d;
  }
  // 年齡（以某天為準）
  const ageOn = (birthday, date) => {
    let a = Number(date.slice(0, 4)) - Number(birthday.slice(0, 4));
    if (date.slice(5) < birthday.slice(5)) a--;
    return a;
  };

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  // ---------- 公開 API ----------
  route('GET', /^\/api\/config$/, () => ({
    schoolName: cfg.schoolName, address: cfg.address, addressNote: cfg.addressNote, facebookUrl: cfg.facebookUrl,
    cancelHours: cfg.cancelHours, bookAheadDays: cfg.bookAheadDays, timeZone: cfg.timeZone, now: now(),
    categories: CATEGORIES,
  }));

  route('GET', /^\/api\/templates$/, () => ({ templates: store.listTemplates().map(publicTemplate) }));

  route('GET', /^\/api\/slots$/, (req, url) => {
    const d = today();
    let from = url.searchParams.get('from') || d;
    if (!T.isValidDate(from)) throw new HttpError(400, '日期格式錯誤');
    if (from < d) from = d;
    const days = Math.min(Number(url.searchParams.get('days')) || 7, 62);
    const lastDay = T.addDays(d, cfg.bookAheadDays + 1);
    let to = T.addDays(from, days);
    if (to > lastDay) to = lastDay;
    if (from >= to) return { slots: [] };
    ensureGenerated(lastDay);
    const me = currentStudent(req, false);
    const mine = new Set(me ? store.studentBookings(me.id, from + 'T00:00')
      .filter((b) => b.status === 'active').map((b) => b.slot_id) : []);
    return {
      slots: store.listSlots(from + 'T00:00', to + 'T00:00').filter(isOpen)
        .map((s) => ({ ...publicSlot(s), mine: mine.has(s.id) })),
    };
  });

  // 學員用信箱登入（信箱需由老師在後台建立）
  route('POST', /^\/api\/login$/, (req, url, body) => {
    checkThrottle(req);
    const email = normEmail(body.email);
    const st = store.getStudentByEmail(email);
    if (!st) { recordFail(req, 10); throw new HttpError(404, '找不到這個信箱的學員資料，請確認信箱或聯絡老師'); }
    if (!st.active) throw new HttpError(403, '這個帳號目前已停用，請聯絡老師');
    return { token: store.createSession('student', st.id, STUDENT_SESSION_MS), student: publicStudent(st) };
  });

  route('POST', /^\/api\/logout$/, (req) => {
    const t = bearer(req);
    if (t) store.deleteSession(t);
    return { ok: true };
  });

  route('GET', /^\/api\/me$/, (req) => ({ student: publicStudent(currentStudent(req)) }));

  route('POST', /^\/api\/bookings$/, (req, url, body) => {
    const me = currentStudent(req);
    const slotId = int(body.slotId, 1, Number.MAX_SAFE_INTEGER, '課程');
    const note = str(body.note, 200, '備註', { required: false });
    const slot = store.getSlot(slotId);
    if (slot && slot.start_at.slice(0, 10) > T.addDays(today(), cfg.bookAheadDays)) {
      throw new HttpError(409, '這堂課尚未開放預約');
    }
    const r = store.book({ slotId, studentId: me.id, note, trial: false, bookedBy: 'student', isOpen,
      usePass: 'auto', requirePass: cfg.requirePass });
    if (r.error) throw new HttpError(r.status, r.error);
    return { status: 201, body: { id: r.booking.id, slot: publicSlot(r.slot), pass: r.pass && publicPass(r.pass) } };
  });

  // 預約前先看會扣哪張卡
  route('GET', /^\/api\/bookings\/preview$/, (req, url) => {
    const me = currentStudent(req);
    const pass = store.previewPass(Number(url.searchParams.get('slotId')), me.id);
    return { pass: pass && publicPass(pass), required: cfg.requirePass };
  });

  route('GET', /^\/api\/my\/passes$/, (req) => {
    const me = currentStudent(req);
    return { passes: store.listPasses(me.id).filter((p) => !p.voided).map(publicPass) };
  });

  route('GET', /^\/api\/my\/bookings$/, (req) => {
    const me = currentStudent(req);
    const since = T.addDays(today(), -14) + 'T00:00';
    return {
      student: publicStudent(me),
      bookings: store.studentBookings(me.id, since).map((b) => ({
        id: b.id, status: b.status, trial: !!b.trial, note: b.note, passName: b.pass_name, title: b.title, subtitle: b.subtitle,
        category: b.category, startAt: b.start_at, durationMin: b.duration_min, past: b.start_at <= now(),
        slotCancelled: !!b.slot_cancelled, cancellable: b.status === 'active' && !b.slot_cancelled && canCancel(b),
      })),
    };
  });

  route('POST', /^\/api\/my\/bookings\/(\d+)\/cancel$/, (req, url, body, [, id]) => {
    const me = currentStudent(req);
    const b = store.getBooking(Number(id));
    if (!b || b.student_id !== me.id) throw new HttpError(404, '找不到這筆預約');
    if (b.status !== 'active') throw new HttpError(409, '這筆預約已經取消了');
    if (!canCancel(store.getSlot(b.slot_id))) throw new HttpError(409, `上課前 ${cfg.cancelHours} 小時內無法線上取消，請直接聯絡老師`);
    store.cancelBooking(b.id);
    return { ok: true };
  });

  // ---------- 老師後台 API ----------
  route('POST', /^\/api\/admin\/login$/, (req, url, body) => {
    checkThrottle(req);
    if (!cfg.adminPassword) throw new HttpError(503, '尚未設定後台密碼（ADMIN_PASSWORD），後台暫時無法登入');
    const a = crypto.createHash('sha256').update(String(body.password ?? '')).digest();
    const b = crypto.createHash('sha256').update(cfg.adminPassword).digest();
    if (!crypto.timingSafeEqual(a, b)) { recordFail(req, 5); throw new HttpError(401, '密碼錯誤'); }
    loginFails.delete(req.socket.remoteAddress || '');
    return { token: store.createSession('admin', null, ADMIN_SESSION_MS) };
  });

  route('POST', /^\/api\/admin\/logout$/, (req) => {
    const t = bearer(req);
    if (t) store.deleteSession(t);
    return { ok: true };
  });

  // ----- 學員資料 -----
  route('GET', /^\/api\/admin\/students$/, (req) => {
    requireAdmin(req);
    const summary = store.passSummary(today());
    return {
      students: store.listStudents(now()).map((st) => ({
        credits: summary[st.id] || { remaining: 0, nextExpiry: null, future: 0 },
        ...publicStudent(st), note: st.note, birthday: st.birthday, active: !!st.active, createdAt: st.created_at, lastLogin: st.last_login,
        upcoming: st.upcoming, attended: st.attended, lastClass: st.last_class,
      })),
    };
  });

  route('POST', /^\/api\/admin\/students$/, (req, url, body) => {
    requireAdmin(req);
    const input = parseStudent(body);
    if (store.getStudentByEmail(input.email)) throw new HttpError(409, `信箱 ${input.email} 已經有學員資料了`);
    return { status: 201, body: { id: store.createStudent(input) } };
  });

  // 一次貼上多位學員
  route('POST', /^\/api\/admin\/students\/batch$/, (req, url, body) => {
    requireAdmin(req);
    if (!Array.isArray(body.students) || !body.students.length) throw new HttpError(400, '沒有學員資料');
    if (body.students.length > 1000) throw new HttpError(400, '一次最多 1000 位');
    const items = body.students.map((x, i) => {
      try { return parseStudent(x || {}); }
      catch (e) { throw new HttpError(400, `第 ${i + 1} 筆：${e.message}`); }
    });
    const emails = new Set();
    for (const it of items) {
      if (emails.has(it.email)) throw new HttpError(400, `信箱重複：${it.email}`);
      emails.add(it.email);
    }
    return { status: 201, body: store.createStudents(items) };
  });

  // 某月壽星（預設本月）：依生日日期排序，附上當月滿幾歲
  route('GET', /^\/api\/admin\/birthdays$/, (req, url) => {
    requireAdmin(req);
    const d = today();
    const month = url.searchParams.get('month') || d.slice(0, 7); // 'YYYY-MM'
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, '月份格式錯誤');
    const mm = month.slice(5);
    const list = store.listStudents(now())
      .filter((st) => st.active && st.birthday && st.birthday.slice(5, 7) === mm)
      .map((st) => {
        const day = `${month}-${st.birthday.slice(8)}`;
        return { id: st.id, name: st.name, birthday: st.birthday, day, age: ageOn(st.birthday, day), isToday: day === d, passed: day < d };
      })
      .sort((a, b) => a.day.localeCompare(b.day) || a.name.localeCompare(b.name));
    return { month, today: d, students: list };
  });

  // ----- 堂數卡 -----
  route('GET', /^\/api\/admin\/students\/(\d+)\/passes$/, (req, url, body, [, id]) => {
    requireAdmin(req);
    if (!store.getStudent(Number(id))) throw new HttpError(404, '找不到這位學員');
    return { passes: store.listPasses(Number(id)).map(publicPass) };
  });

  route('POST', /^\/api\/admin\/students\/(\d+)\/passes$/, (req, url, body, [, id]) => {
    requireAdmin(req);
    if (!store.getStudent(Number(id))) throw new HttpError(404, '找不到這位學員');
    return { status: 201, body: { id: store.createPass(Number(id), parsePass(body)) } };
  });

  route('PUT', /^\/api\/admin\/passes\/(\d+)$/, (req, url, body, [, id]) => {
    requireAdmin(req);
    const p = store.getPass(Number(id));
    if (!p) throw new HttpError(404, '找不到這張堂數卡');
    const input = parsePass(body);
    if (input.total < p.used) throw new HttpError(409, `已經用了 ${p.used} 堂，總堂數不能少於這個數字`);
    store.updatePass(p.id, input);
    return { ok: true };
  });

  route('POST', /^\/api\/admin\/passes\/(\d+)\/(void|restore)$/, (req, url, body, [, id, act]) => {
    requireAdmin(req);
    if (!store.setPassVoided(Number(id), act === 'void')) throw new HttpError(404, '找不到這張堂數卡');
    return { ok: true };
  });

  route('DELETE', /^\/api\/admin\/passes\/(\d+)$/, (req, url, body, [, id]) => {
    requireAdmin(req);
    if (!store.getPass(Number(id))) throw new HttpError(404, '找不到這張堂數卡');
    if (!store.deletePass(Number(id))) throw new HttpError(409, '這張卡已經用來約過課，無法刪除，請改用「作廢」');
    return { ok: true };
  });

  route('PUT', /^\/api\/admin\/students\/(\d+)$/, (req, url, body, [, id]) => {
    requireAdmin(req);
    const input = parseStudent(body);
    const other = store.getStudentByEmail(input.email);
    if (other && other.id !== Number(id)) throw new HttpError(409, `信箱 ${input.email} 已經被 ${other.name} 使用`);
    if (!store.updateStudent(Number(id), input)) throw new HttpError(404, '找不到這位學員');
    return { ok: true };
  });

  route('POST', /^\/api\/admin\/students\/(\d+)\/(activate|deactivate)$/, (req, url, body, [, id, act]) => {
    requireAdmin(req);
    if (!store.setStudentActive(Number(id), act === 'activate')) throw new HttpError(404, '找不到這位學員');
    return { ok: true };
  });

  route('DELETE', /^\/api\/admin\/students\/(\d+)$/, (req, url, body, [, id]) => {
    requireAdmin(req);
    const r = store.deleteStudent(Number(id));
    if (r === null) throw new HttpError(404, '找不到這位學員');
    if (r === false) throw new HttpError(409, '這位學員有預約紀錄，無法刪除，請改用「停用」');
    return { ok: true };
  });

  route('GET', /^\/api\/admin\/students\/(\d+)\/bookings$/, (req, url, body, [, id]) => {
    requireAdmin(req);
    const st = store.getStudent(Number(id));
    if (!st) throw new HttpError(404, '找不到這位學員');
    return {
      bookings: store.studentBookings(st.id, '0000').reverse().map((b) => ({
        id: b.id, status: b.status, trial: !!b.trial, passName: b.pass_name, title: b.title, category: b.category, startAt: b.start_at,
        durationMin: b.duration_min, slotCancelled: !!b.slot_cancelled, past: b.start_at <= now(),
      })),
    };
  });

  route('GET', /^\/api\/admin\/slots$/, (req, url) => {
    requireAdmin(req);
    const from = url.searchParams.get('from') || today();
    const to = url.searchParams.get('to') || T.addDays(from, 7);
    if (!T.isValidDate(from) || !T.isValidDate(to)) throw new HttpError(400, '日期格式錯誤');
    ensureGenerated(to > T.addDays(today(), cfg.bookAheadDays + 1) ? to : T.addDays(today(), cfg.bookAheadDays + 1));
    return {
      now: now(),
      slots: store.listSlots(from + 'T00:00', to + 'T00:00').map((s) => ({
        ...publicSlot(s), cancelled: !!s.cancelled, fromTemplate: s.template_id != null,
        bookings: store.slotBookings(s.id).map((b) => ({
          id: b.id, studentId: b.student_id, name: b.name, email: b.email, phone: b.phone, note: b.note,
          trial: !!b.trial, bookedBy: b.booked_by, status: b.status, createdAt: b.created_at,
          passId: b.pass_id, passName: b.pass_name,
          birthdayToday: !!b.birthday && b.birthday.slice(5) === s.start_at.slice(5, 10),
        })),
      })),
    };
  });

  // 臨時加開的單堂課
  route('POST', /^\/api\/admin\/slots$/, (req, url, body) => {
    requireAdmin(req);
    return { status: 201, body: { id: store.createSlot(parseSlotInput(body)) } };
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

  // 停課 / 恢復上課
  route('POST', /^\/api\/admin\/slots\/(\d+)\/(cancel|restore)$/, (req, url, body, [, id, act]) => {
    requireAdmin(req);
    if (!store.setCancelled(Number(id), act === 'cancel')) throw new HttpError(404, '找不到這堂課');
    return { ok: true };
  });

  route('DELETE', /^\/api\/admin\/slots\/(\d+)$/, (req, url, body, [, id]) => {
    requireAdmin(req);
    const slot = store.getSlot(Number(id));
    if (!slot) throw new HttpError(404, '找不到這堂課');
    if (slot.template_id != null) throw new HttpError(409, '固定課表的課程請改用「停課」');
    store.deleteSlot(slot.id);
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
    const st = store.getStudent(int(body.studentId, 1, Number.MAX_SAFE_INTEGER, '學員'));
    if (!st) throw new HttpError(404, '找不到這位學員');
    const r = store.book({
      slotId: Number(id), studentId: st.id, note: str(body.note, 200, '備註', { required: false }),
      trial: body.trial === true, bookedBy: 'admin', isOpen: (s) => !s.cancelled,
      usePass: body.trial === true || body.usePass === 'none' ? 'none' : 'auto',
    });
    if (r.error) throw new HttpError(r.status, r.error);
    return { status: 201, body: { id: r.booking.id, pass: r.pass && publicPass(r.pass) } };
  });

  // 固定課表
  route('GET', /^\/api\/admin\/templates$/, (req) => {
    requireAdmin(req);
    return { templates: store.listTemplates().map(publicTemplate) };
  });

  route('POST', /^\/api\/admin\/templates$/, (req, url, body) => {
    requireAdmin(req);
    if (!T.isValidTime(body.time)) throw new HttpError(400, '時間格式錯誤');
    const id = store.createTemplate({ ...parseClassFields(body), weekday: int(body.weekday, 0, 6, '星期'), time: body.time });
    resetGenerated();
    return { status: 201, body: { id } };
  });

  route('PUT', /^\/api\/admin\/templates\/(\d+)$/, (req, url, body, [, id]) => {
    requireAdmin(req);
    if (!store.updateTemplate(Number(id), parseClassFields(body), now())) throw new HttpError(404, '找不到這個時段');
    return { ok: true };
  });

  route('DELETE', /^\/api\/admin\/templates\/(\d+)$/, (req, url, body, [, id]) => {
    requireAdmin(req);
    const kept = store.deleteTemplate(Number(id), now());
    if (kept === null) throw new HttpError(404, '找不到這個時段');
    resetGenerated();
    return { ok: true, kept };
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
    res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  function serveStatic(req, res, pathname) {
    pathname = PAGES[pathname] || pathname;
    let file;
    try { file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname))); }
    catch { res.writeHead(400); return res.end(); }
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
    // 在 Railway 等平台後面時，用 http 進來的一律轉到 https
    if (req.headers['x-forwarded-proto'] === 'http' && req.headers.host) {
      res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` });
      return res.end();
    }
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
  if (!cfg.adminPassword) {
    console.warn('⚠️  尚未設定 ADMIN_PASSWORD，後台無法登入。請在 .env 檔或環境變數中設定。');
  }
  createApp(cfg).listen(cfg.port, () => {
    console.log(`✅ ${cfg.schoolName} 約課系統已啟動：http://localhost:${cfg.port}`);
    console.log(`   老師後台：http://localhost:${cfg.port}/admin`);
  });
}

module.exports = { createApp, loadConfig };
