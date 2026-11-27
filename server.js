'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDb, createStore, passStatus } = require('./lib/db');
const { createMailer, resetPasswordMail } = require('./lib/mail');
const R = require('./lib/rental');
const { buildXlsx } = require('./lib/xlsx');
const { CATEGORIES, CATEGORY_IDS, DEFAULT_TEMPLATES } = require('./lib/schedule');
const T = require('./lib/time');

// 自動讀取專案資料夾中的 .env（不會被上傳到 git）
const ENV_FILE = path.join(__dirname, '.env');
if (require.main === module && fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const PUBLIC_DIR = path.join(__dirname, 'public');
const PAGES = {
  '/': '/index.html', '/my': '/my.html', '/info': '/info.html', '/admin': '/admin.html',
  '/register': '/register.html', '/forgot': '/forgot.html', '/reset': '/reset.html', '/rent': '/rent.html', '/rates': '/rates.html',
};
const CONSENT_VERSION = '2026-11';
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
    schoolNameEn: env.SCHOOL_NAME_EN || 'Hwarang Martial Arts',
    addressEn: env.SCHOOL_ADDRESS_EN ?? '2F-1, No. 176, Sec. 1, Zhongxiao E. Rd., Taipei',
    addressNoteEn: env.SCHOOL_ADDRESS_NOTE_EN ?? 'Near Shandao Temple MRT Station, Exit 5',
    address: env.SCHOOL_ADDRESS ?? '台北市忠孝東路一段176號2樓之1',
    addressNote: env.SCHOOL_ADDRESS_NOTE ?? '近善導寺捷運站 5 號出口',
    facebookUrl: env.FACEBOOK_URL || '',
    cancelHours: num(env.CANCEL_HOURS, 2),
    bookCutoffMinutes: num(env.BOOK_CUTOFF_MINUTES, 0),
    bookAheadDays: num(env.BOOK_AHEAD_DAYS, 28) || 28,
    seedSchedule: env.SEED_SCHEDULE !== '0',
    rentalOpen: env.RENTAL_OPEN || '09:00',      // 場地開放租借的時間
    rentalClose: env.RENTAL_CLOSE || '22:00',
    rentalMaxHours: num(env.RENTAL_MAX_HOURS, 10),
    requireRentalPass: env.REQUIRE_RENTAL_PASS !== '0', // 學員自己租場地時需要場地租借時數
    rentalCutoffHours: num(env.RENTAL_CUTOFF_HOURS, 2), // 場地需在開始前幾小時完成預約
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),  // 例如 https://booking.hwarang-tkd-tw.com（寄信連結用）
    resendApiKey: env.RESEND_API_KEY || '',
    mailFrom: env.MAIL_FROM || '',                            // 例如 花郎武道館 <no-reply@hwarang-tkd-tw.com>
    requirePass: env.REQUIRE_PASS !== '0', // 學員自己約課時需要有可用堂數
  };
}

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

// 密碼雜湊：scrypt，格式 scrypt$鹽$雜湊
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${crypto.scryptSync(pw, salt, 64).toString('base64')}`;
}
function verifyPassword(pw, stored) {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
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
  const mailer = cfg.mailer || createMailer({ apiKey: cfg.resendApiKey, from: cfg.mailFrom });
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
    id: s.id, title: s.title, subtitle: s.subtitle, titleEn: s.title_en, subtitleEn: s.subtitle_en,
    category: s.category, startAt: s.start_at,
    durationMin: s.duration_min, capacity: s.capacity, booked: s.booked,
    remaining: Math.max(0, s.capacity - s.booked), note: s.note, open: isOpen(s),
  });
  const publicTemplate = (t) => ({
    id: t.id, title: t.title, subtitle: t.subtitle, titleEn: t.title_en, subtitleEn: t.subtitle_en,
    category: t.category, weekday: t.weekday, time: t.time,
    durationMin: t.duration_min, capacity: t.capacity, note: t.note,
  });

  function parseClassFields(b) {
    return {
      title: str(b.title, 60, '課程名稱'),
      subtitle: str(b.subtitle, 80, '副標題', { required: false }),
      titleEn: str(b.titleEn, 80, '英文名稱', { required: false }),
      subtitleEn: str(b.subtitleEn, 80, '英文副標題', { required: false }),
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
  /**
   * 登入中的「家庭」：與登入學員同一個信箱、而且啟用中的所有學員（例如兄弟姊妹共用家長信箱）。
   * required=false 時未登入回傳 null。
   */
  function currentFamily(req, required = true) {
    const t = bearer(req);
    const s = t && store.getSession(t);
    const anchor = s && s.role === 'student' && store.getStudent(s.student_id);
    const family = anchor ? store.studentsByEmail(anchor.email).filter((x) => x.active) : [];
    if (family.length) return family;
    if (required) throw new HttpError(401, '請先用信箱登入');
    return null;
  }
  /** 從家庭中挑出要操作的學員；只有一位時可省略 studentId。 */
  function pickMember(family, studentId) {
    if (studentId === undefined || studentId === null || studentId === '') {
      if (family.length === 1) return family[0];
      throw new HttpError(400, '請選擇要幫哪位學員預約');
    }
    const st = family.find((x) => x.id === Number(studentId));
    if (!st) throw new HttpError(403, '這位學員不在你的帳號裡');
    return st;
  }
  const publicPass = (p) => ({
    id: p.id, name: p.name, unlimited: !!p.unlimited, total: p.total, used: p.used,
    remaining: p.unlimited ? null : Math.max(0, p.total - p.used),    // 無限堂沒有剩餘堂數的概念
    purchaseDate: p.purchase_date, startDate: p.start_date, endDate: p.end_date, categories: p.categories ? p.categories.split(',') : [],
    note: p.note, status: passStatus(p, today()),
    bookedUsed: p.booked_used, adjust: p.adjust,   // 已用 = 系統預約扣的 + 手動調整
    kind: p.kind || 'class',                       // class 上課堂數 / rental 場地租借時數（小時）
  });
  function parsePass(b) {
    if (!T.isValidDate(b.startDate) || !T.isValidDate(b.endDate)) throw new HttpError(400, '請填寫正確的開始與到期日期');
    if (b.endDate < b.startDate) throw new HttpError(400, '到期日不能早於開始日');
    const purchaseDate = b.purchaseDate || today();
    if (!T.isValidDate(purchaseDate)) throw new HttpError(400, '購買日格式錯誤');
    if (purchaseDate > today()) throw new HttpError(400, '購買日不能晚於今天');
    // 卡種：class 上課堂數（適用課程分類）、rental 場地租借時數（適用租借類型，以小時計、可到半小時）
    const kind = b.kind === 'rental' ? 'rental' : 'class';
    const allowed = kind === 'rental' ? Object.keys(R.RENTAL_TYPES) : CATEGORY_IDS;
    const cats = Array.isArray(b.categories) ? b.categories.filter((c) => allowed.includes(c)) : [];
    const unlimited = b.unlimited === true;
    return {
      name: str(b.name, 40, '方案名稱'),
      kind,
      unlimited,
      total: unlimited ? 0 : kind === 'rental' ? halfHours(b.total, 0.5, 1000, '時數') : int(b.total, 1, 500, '堂數'),
      startDate: b.startDate, endDate: b.endDate,
      categories: [...new Set(cats)].join(','),
      note: str(b.note, 200, '備註', { required: false }),
      purchaseDate,
    };
  }
  /** 以半小時為單位的數字（場地時數）。 */
  function halfHours(v, min, max, field) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max || Math.round(n * 2) !== n * 2) {
      throw new HttpError(400, `${field}需為 ${min}–${max}，以 0.5 為單位`);
    }
    return n;
  }
  const publicStudent = (st) => ({ id: st.id, name: st.name, email: st.email, phone: st.phone });
  const GENDERS = ['M', 'F', 'X'];
  function parseStudent(b) {
    return {
      name: str(b.name, 40, '姓名'),
      email: normEmail(b.email),
      phone: normPhone(b.phone),
      note: str(b.note, 300, '備註', { required: false }),
      birthday: parseBirthday(b.birthday),
      gender: GENDERS.includes(b.gender) ? b.gender : '',
      healthNotes: str(b.healthNotes, 500, '須留意的身心狀況', { required: false }),
    };
  }
  function parsePassword(v) {
    const pw = typeof v === 'string' ? v : '';
    if (pw.length < 8) throw new HttpError(400, '密碼至少需要 8 個字元');
    if (pw.length > 200) throw new HttpError(400, '密碼太長');
    return pw;
  }
  /** 自行註冊的學員資料：姓名、性別、生日必填；身心狀況選填。 */
  function parseRegistrant(b, email, consent) {
    const name = str(b && b.name, 40, '姓名');
    if (!GENDERS.includes(b.gender)) throw new HttpError(400, `請選擇${name}的性別`);
    const birthday = parseBirthday(b.birthday);
    if (!birthday) throw new HttpError(400, `請填寫${name}的生日`);
    return {
      name, email, birthday, gender: b.gender, phone: normPhone(b.phone),
      healthNotes: str(b.healthNotes, 500, '須留意的身心狀況', { required: false }), note: '', source: 'self', ...consent,
    };
  }
  /** 同意書：個資蒐集必須同意；攝影使用需選擇同意或不同意。 */
  function parseConsent(b) {
    if (b.consentPrivacy !== true) throw new HttpError(400, '請閱讀並同意個人資料蒐集同意書');
    if (!['yes', 'no'].includes(b.consentPhoto)) throw new HttpError(400, '請選擇是否同意攝影使用');
    return { consentPrivacyAt: now(), consentPhoto: b.consentPhoto, consentVersion: CONSENT_VERSION };
  }
  const baseUrl = (req) => cfg.publicUrl
    || `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host}`;
  const RESET_HOURS = 24, ADMIN_RESET_DAYS = 7;
  const loginResult = (family) => ({
    token: store.createSession('student', family[0].id, STUDENT_SESSION_MS),
    students: family.map(publicStudent),
  });
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
    schoolNameEn: cfg.schoolNameEn, addressEn: cfg.addressEn, addressNoteEn: cfg.addressNoteEn,
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
    // 登入時標示家庭成員已預約的課：slotId → [studentId]
    const booked = new Map();
    for (const st of currentFamily(req, false) || []) {
      for (const b of store.studentBookings(st.id, from + 'T00:00')) {
        if (b.status === 'active') booked.set(b.slot_id, [...(booked.get(b.slot_id) || []), st.id]);
      }
    }
    return {
      slots: store.listSlots(from + 'T00:00', to + 'T00:00').filter(isOpen)
        .map((s) => ({ ...publicSlot(s), mine: booked.has(s.id), mineIds: booked.get(s.id) || [] })),
    };
  });

  // 學員用信箱＋密碼登入
  route('POST', /^\/api\/login$/, (req, url, body) => {
    checkThrottle(req);
    const email = normEmail(body.email);
    const all = store.studentsByEmail(email);
    if (!all.length) { recordFail(req, 10); throw new HttpError(401, '信箱或密碼錯誤'); }
    const account = store.getAccount(email);
    if (!account) {
      throw new HttpError(409, '這個信箱還沒有設定密碼，請按「忘記密碼」用信箱設定密碼', 'NO_PASSWORD');
    }
    if (!verifyPassword(body.password, account.password_hash)) { recordFail(req, 10); throw new HttpError(401, '信箱或密碼錯誤'); }
    const family = all.filter((x) => x.active);
    if (!family.length) throw new HttpError(403, '這個帳號目前已停用，請聯絡老師');
    return loginResult(family);
  });

  // 新生註冊：一次可登記多位學員（例如兄弟姊妹），註冊後自動登入
  route('POST', /^\/api\/register$/, (req, url, body) => {
    checkThrottle(req);
    const email = normEmail(body.email);
    const password = parsePassword(body.password);
    if (store.studentsByEmail(email).length) {
      throw new HttpError(409, '這個信箱已經註冊過了，請直接登入（忘記密碼可以重設）', 'EMAIL_EXISTS');
    }
    const consent = parseConsent(body);
    const list = Array.isArray(body.students) ? body.students : [];
    if (!list.length || list.length > 10) throw new HttpError(400, '請填寫學員資料');
    const items = list.map((x) => parseRegistrant(x, email, consent));
    store.setPassword(email, hashPassword(password));
    store.registerStudents(items);
    return { status: 201, body: loginResult(store.studentsByEmail(email).filter((x) => x.active)) };
  });

  // 已登入的家長幫家人（例如弟弟妹妹）新增學員資料
  route('POST', /^\/api\/my\/students$/, (req, url, body) => {
    const family = currentFamily(req);
    const email = family[0].email;
    const consent = parseConsent(body);
    const list = Array.isArray(body.students) ? body.students : [];
    if (!list.length || list.length > 10) throw new HttpError(400, '請填寫學員資料');
    const items = list.map((x) => parseRegistrant(x, email, consent));
    for (const it of items) {
      if (store.findStudent(email, it.name)) throw new HttpError(409, `已經有學員「${it.name}」了`);
    }
    store.registerStudents(items);
    return { status: 201, body: { students: store.studentsByEmail(email).filter((x) => x.active).map(publicStudent) } };
  });

  // 忘記密碼：寄出設定密碼連結（舊生第一次設定密碼也用這個）
  route('POST', /^\/api\/password\/forgot$/, async (req, url, body) => {
    checkThrottle(req);
    const email = normEmail(body.email);
    const family = store.studentsByEmail(email).filter((x) => x.active);
    if (!mailer.enabled) {
      return { ok: true, sent: false, message: '網站目前無法寄信，請聯絡老師取得設定密碼的連結' };
    }
    recordFail(req, 10); // 限制頻率，避免被拿來大量寄信
    if (family.length) {
      const link = `${baseUrl(req)}/reset?token=${store.createReset(email, RESET_HOURS * 3600e3)}`;
      try {
        await mailer.send({ to: email, ...resetPasswordMail({
          school: cfg.schoolName, schoolEn: cfg.schoolNameEn, names: family.map((x) => x.name), link, hours: RESET_HOURS,
        }) });
      } catch (e) {
        console.error('寄信失敗', e.message);
        throw new HttpError(502, '寄信失敗，請稍後再試或聯絡老師');
      }
    }
    // 不透露這個信箱有沒有註冊
    return { ok: true, sent: true };
  });

  route('GET', /^\/api\/password\/reset$/, (req, url) => {
    const email = store.checkReset(url.searchParams.get('token'));
    if (!email) throw new HttpError(410, '這個連結已失效或已使用過，請重新申請');
    return { email, students: store.studentsByEmail(email).filter((x) => x.active).map((x) => x.name) };
  });

  route('POST', /^\/api\/password\/reset$/, (req, url, body) => {
    const email = store.checkReset(body.token);
    if (!email) throw new HttpError(410, '這個連結已失效或已使用過，請重新申請');
    const password = parsePassword(body.password);
    store.resetPassword(email, hashPassword(password));
    const family = store.studentsByEmail(email).filter((x) => x.active);
    if (!family.length) throw new HttpError(403, '這個帳號目前已停用，請聯絡老師');
    return loginResult(family);
  });

  route('POST', /^\/api\/my\/password$/, (req, url, body) => {
    const family = currentFamily(req);
    const email = family[0].email;
    const account = store.getAccount(email);
    if (account && !verifyPassword(body.current, account.password_hash)) throw new HttpError(401, '目前的密碼不正確');
    store.setPassword(email, hashPassword(parsePassword(body.password)));
    return { ok: true };
  });

  route('POST', /^\/api\/logout$/, (req) => {
    const t = bearer(req);
    if (t) store.deleteSession(t);
    return { ok: true };
  });

  route('GET', /^\/api\/me$/, (req) => ({ students: currentFamily(req).map(publicStudent) }));

  route('POST', /^\/api\/bookings$/, (req, url, body) => {
    const me = pickMember(currentFamily(req), body.studentId);
    const slotId = int(body.slotId, 1, Number.MAX_SAFE_INTEGER, '課程');
    const note = str(body.note, 200, '備註', { required: false });
    const slot = store.getSlot(slotId);
    if (slot && slot.start_at.slice(0, 10) > T.addDays(today(), cfg.bookAheadDays)) {
      throw new HttpError(409, '這堂課尚未開放預約');
    }
    const r = store.book({ slotId, studentId: me.id, note, trial: false, bookedBy: 'student', isOpen,
      usePass: 'auto', requirePass: cfg.requirePass });
    if (r.error) throw new HttpError(r.status, r.error);
    return { status: 201, body: {
      id: r.booking.id, student: publicStudent(me), slot: publicSlot(r.slot), pass: r.pass && publicPass(r.pass),
    } };
  });

  // 預約前先看會扣哪張卡
  route('GET', /^\/api\/bookings\/preview$/, (req, url) => {
    const me = pickMember(currentFamily(req), url.searchParams.get('studentId'));
    const pass = store.previewPass(Number(url.searchParams.get('slotId')), me.id);
    return { pass: pass && publicPass(pass), required: cfg.requirePass };
  });

  route('GET', /^\/api\/my\/passes$/, (req) => {
    const family = currentFamily(req);
    return {
      passes: family.flatMap((st) => store.listPasses(st.id).filter((p) => !p.voided)
        .map((p) => ({ ...publicPass(p), studentId: st.id, studentName: st.name }))),
    };
  });

  route('GET', /^\/api\/my\/bookings$/, (req) => {
    const family = currentFamily(req);
    const since = T.addDays(today(), -14) + 'T00:00';
    const rows = family.flatMap((st) => store.studentBookings(st.id, since).map((b) => ({ ...b, st })))
      .sort((a, b) => a.start_at.localeCompare(b.start_at) || a.st.id - b.st.id);
    return {
      students: family.map(publicStudent),
      bookings: rows.map((b) => ({
        studentId: b.st.id, studentName: b.st.name,
        id: b.id, status: b.status, trial: !!b.trial, note: b.note, passName: b.pass_name, title: b.title, subtitle: b.subtitle,
        titleEn: b.title_en, subtitleEn: b.subtitle_en,
        category: b.category, startAt: b.start_at, durationMin: b.duration_min, past: b.start_at <= now(),
        slotCancelled: !!b.slot_cancelled, cancellable: b.status === 'active' && !b.slot_cancelled && canCancel(b),
      })),
    };
  });

  route('POST', /^\/api\/my\/bookings\/(\d+)\/cancel$/, (req, url, body, [, id]) => {
    const family = currentFamily(req);
    const b = store.getBooking(Number(id));
    if (!b || !family.some((x) => x.id === b.student_id)) throw new HttpError(404, '找不到這筆預約');
    if (b.status !== 'active') throw new HttpError(409, '這筆預約已經取消了');
    if (!canCancel(store.getSlot(b.slot_id))) throw new HttpError(409, `上課前 ${cfg.cancelHours} 小時內無法線上取消，請直接聯絡老師`);
    store.cancelBooking(b.id);
    return { ok: true };
  });

  // ---------- 場地租借 ----------
  const publicRentalTypes = () => Object.fromEntries(Object.entries(R.RENTAL_TYPES)
    .map(([k, t]) => [k, { name: t.name, nameEn: t.nameEn, rate: t.rate, per: t.per, cap: t.cap, exclusive: t.exclusive }]));

  /** 驗證租借時段：對齊 30 分鐘、在開放時間內、至少 1 小時。 */
  function parseRental(b) {
    const type = b.type;
    if (!R.RENTAL_TYPES[type]) throw new HttpError(400, '請選擇租借類型');
    if (!T.isValidDate(b.date)) throw new HttpError(400, '日期格式錯誤');
    if (!T.isValidTime(b.start) || R.toMin(b.start) % R.STEP) throw new HttpError(400, '開始時間需為整點或半點');
    const hours = Number(b.hours);
    if (!(hours >= 1 && hours <= cfg.rentalMaxHours && (hours * 60) % R.STEP === 0)) {
      throw new HttpError(400, `租借時數需為 1～${cfg.rentalMaxHours} 小時（以半小時為單位）`);
    }
    const startM = R.toMin(b.start), endM = startM + hours * 60;
    if (startM < R.toMin(cfg.rentalOpen) || endM > R.toMin(cfg.rentalClose)) {
      throw new HttpError(400, `場地開放時間為 ${cfg.rentalOpen}–${cfg.rentalClose}`);
    }
    const people = type === 'self' ? int(b.people ?? 1, 1, R.RENTAL_TYPES.self.cap, '人數') : 1;
    // 扣的時數：自主訓練按人數 × 小時，其他按小時
    return { type, date: b.date, start: b.start, end: R.toTime(endM), minutes: hours * 60, people, units: hours * people,
      price: R.rentalPrice(type, hours * 60, people), note: str(b.note, 200, '備註', { required: false }) };
  }
  /** 在交易中檢查：時段內每 30 分鐘都沒有課程、而且還沒到上限。 */
  function rentalConflict(r) {
    const segs = R.daySegments({ open: cfg.rentalOpen, close: cfg.rentalClose, slots: store.slotsOnDay(r.date), rentals: store.rentalsOn(r.date) });
    for (const sg of segs) {
      if (sg.start < R.toMin(r.end) && R.toMin(r.start) < sg.end) {
        const e = R.checkSegment(sg, r.type, r.people);
        if (e) return `${r.date} ${sg.time}：${e}`;
      }
    }
    return null;
  }
  const publicRental = (r) => ({
    id: r.id, type: r.type, date: r.date, start: r.start, end: r.end, people: r.people, price: r.price, note: r.note,
    paid: !!r.paid, status: r.status, contactName: r.contact_name, contactPhone: r.contact_phone, bookedBy: r.booked_by,
    studentId: r.student_id, past: `${r.date}T${r.start}` <= now(),
    passName: r.pass_name || null, units: r.units,
  });

  route('GET', /^\/api\/rentals\/config$/, () => ({
    types: publicRentalTypes(), open: cfg.rentalOpen, close: cfg.rentalClose, maxHours: cfg.rentalMaxHours,
    bookAheadDays: cfg.bookAheadDays, cancelHours: cfg.cancelHours, cutoffHours: cfg.rentalCutoffHours, now: now(),
    requirePass: cfg.requireRentalPass,
  }));

  // 預覽：這筆租借會扣哪張場租卡
  route('GET', /^\/api\/rentals\/preview$/, (req, url) => {
    const me = pickMember(currentFamily(req), url.searchParams.get('studentId'));
    const r = parseRental(Object.fromEntries(url.searchParams));
    const pass = store.previewRentalPass(me.id, r);
    return { pass: pass && publicPass(pass), units: r.units, required: cfg.requireRentalPass };
  });

  route('GET', /^\/api\/rentals\/availability$/, (req, url) => {
    const date = url.searchParams.get('date');
    if (!T.isValidDate(date)) throw new HttpError(400, '日期格式錯誤');
    ensureGenerated(T.addDays(today(), cfg.bookAheadDays + 1));
    const segs = R.daySegments({ open: cfg.rentalOpen, close: cfg.rentalClose, slots: store.slotsOnDay(date), rentals: store.rentalsOn(date) });
    const nowT = now();
    return {
      date,
      // closed：已經過了或不到截止時間，不能再線上預約
      segments: segs.map((sg) => ({ time: sg.time, closed: T.minutesBetween(nowT, `${date}T${sg.time}`) < cfg.rentalCutoffHours * 60,
        classBusy: sg.classBusy,
        group: sg.group, private: sg.private, self: sg.self })),
    };
  });

  route('POST', /^\/api\/rentals$/, (req, url, body) => {
    const me = pickMember(currentFamily(req), body.studentId);
    const r = parseRental(body);
    if (T.minutesBetween(now(), `${r.date}T${r.start}`) < cfg.rentalCutoffHours * 60) {
      throw new HttpError(409, `場地需在開始前 ${cfg.rentalCutoffHours} 小時完成預約`);
    }
    if (r.date > T.addDays(today(), cfg.bookAheadDays)) throw new HttpError(409, `只能預約 ${cfg.bookAheadDays} 天內的場地`);
    const out = store.bookRentals([{ ...r, studentId: me.id, contactName: me.name, contactPhone: me.phone, bookedBy: 'student' }],
      rentalConflict, cfg.requireRentalPass ? 'require' : 'auto');
    if (out.error) throw new HttpError(409, out.error, out.code);
    return { status: 201, body: {
      rental: publicRental(store.getRental(out.ids[0])), pass: out.passes[0] && publicPass(out.passes[0]),
    } };
  });

  route('GET', /^\/api\/my\/rentals$/, (req) => {
    const family = currentFamily(req);
    const list = store.rentalsByStudent(family.map((x) => x.id), T.addDays(today(), -14))
      .sort((a, b) => `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`));
    return {
      rentals: list.map((r) => ({ ...publicRental(r),
        cancellable: r.status === 'active' && T.minutesBetween(now(), `${r.date}T${r.start}`) >= cfg.cancelHours * 60 })),
    };
  });

  route('POST', /^\/api\/my\/rentals\/(\d+)\/cancel$/, (req, url, body, [, id]) => {
    const family = currentFamily(req);
    const r = store.getRental(Number(id));
    if (!r || !family.some((x) => x.id === r.student_id)) throw new HttpError(404, '找不到這筆租借');
    if (r.status !== 'active') throw new HttpError(409, '這筆租借已經取消了');
    if (T.minutesBetween(now(), `${r.date}T${r.start}`) < cfg.cancelHours * 60) {
      throw new HttpError(409, `開始前 ${cfg.cancelHours} 小時內無法線上取消，請直接聯絡老師`);
    }
    store.cancelRental(r.id);
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

  // ----- 場地租借（後台） -----
  route('GET', /^\/api\/admin\/rentals$/, (req, url) => {
    requireAdmin(req);
    const from = url.searchParams.get('from') || today();
    const to = url.searchParams.get('to') || T.addDays(from, 7);
    if (!T.isValidDate(from) || !T.isValidDate(to)) throw new HttpError(400, '日期格式錯誤');
    return { rentals: store.rentalsBetween(from, to).map((r) => ({ ...publicRental(r), studentName: r.student_name, studentEmail: r.student_email })) };
  });

  // 老師代訂（可每週重複，例如固定租借時段）；不受「已經過了」的限制，方便補登
  route('POST', /^\/api\/admin\/rentals$/, (req, url, body) => {
    requireAdmin(req);
    const r = parseRental(body);
    let student = null;
    if (body.studentId) {
      student = store.getStudent(Number(body.studentId));
      if (!student) throw new HttpError(404, '找不到這位學員');
    }
    const contactName = student ? student.name : str(body.contactName, 60, '租借人姓名');
    const contactPhone = student ? student.phone : normPhone(body.contactPhone);
    const weeks = int(body.repeatWeeks ?? 1, 1, 52, '重複週數');
    const items = [];
    for (let i = 0; i < weeks; i++) {
      items.push({ ...r, date: T.addDays(r.date, i * 7), studentId: student ? student.id : null, contactName, contactPhone, bookedBy: 'admin' });
    }
    // 代訂給學員時，有場租時數就自動扣；勾「不扣時數」或外部人士則不扣
    const out = store.bookRentals(items, rentalConflict, body.usePass === 'none' ? 'none' : 'auto');
    if (out.error) throw new HttpError(409, out.error);
    const used = out.passes.filter(Boolean);
    return { status: 201, body: { created: out.ids.length, price: r.price, deducted: used.length,
      pass: used.length ? publicPass(store.getPass(used[used.length - 1].id)) : null } };
  });

  route('POST', /^\/api\/admin\/rentals\/(\d+)\/cancel$/, (req, url, body, [, id]) => {
    requireAdmin(req);
    if (!store.getRental(Number(id))) throw new HttpError(404, '找不到這筆租借');
    if (!store.cancelRental(Number(id))) throw new HttpError(409, '這筆租借已經取消了');
    return { ok: true };
  });

  route('POST', /^\/api\/admin\/rentals\/(\d+)\/paid$/, (req, url, body, [, id]) => {
    requireAdmin(req);
    if (!store.setRentalPaid(Number(id), body.paid === true)) throw new HttpError(404, '找不到這筆租借');
    return { ok: true };
  });

  // ----- 報表匯出（約課、場地租借） -----
  const L = {
    zh: {
      dow: ['日', '一', '二', '三', '四', '五', '六'], all: '全部學員',
      booking: ['日期', '星期', '時間', '課程', '學員', '信箱', '電話', '狀態', '使用堂數卡', '體驗課', '預約方式', '備註'],
      rental: ['日期', '星期', '時間', '時數', '類型', '租借人', '電話', '人數', '金額', '付款', '使用時數卡', '扣除時數', '狀態', '預約方式', '備註'],
      perStudent: ['學員', '信箱', '已上課', '已預約（未上）', '學員取消', '停課', '未扣堂', '場地租借筆數', '場地租借金額'],
      st: { attended: '已上課', booked: '已預約', cancelled: '學員取消', slotCancelled: '停課', rentCancelled: '已取消', used: '已使用' },
      yes: '是', paid: '已付款', unpaid: '未付款', unlimited: '（無限堂）', noPass: '未扣堂', byAdmin: '老師代約', bySelf: '學員自己',
      byAdminRent: '老師代訂',
      sheets: ['摘要', '約課', '場地租借', '學員統計'],
      sum: ['期間', '學員', '約課（不含取消）', '已上課', '已預約（未上）', '學員取消', '停課', '未扣堂（可能需收費）',
        '場地租借（不含取消）', '場地租借金額', '已收款', '未收款'],
    },
    en: {
      dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], all: 'All students',
      booking: ['Date', 'Day', 'Time', 'Class', 'Student', 'Email', 'Phone', 'Status', 'Credit card', 'Trial', 'Booked by', 'Note'],
      rental: ['Date', 'Day', 'Time', 'Hours', 'Type', 'Renter', 'Phone', 'People', 'Amount', 'Payment', 'Hours card', 'Hours used', 'Status', 'Booked by', 'Note'],
      perStudent: ['Student', 'Email', 'Attended', 'Upcoming', 'Cancelled', 'Class cancelled', 'No credit', 'Rentals', 'Rental amount'],
      st: { attended: 'Attended', booked: 'Booked', cancelled: 'Cancelled', slotCancelled: 'Class cancelled', rentCancelled: 'Cancelled', used: 'Used' },
      yes: 'Yes', paid: 'Paid', unpaid: 'Unpaid', unlimited: ' (unlimited)', noPass: 'No credit', byAdmin: 'Instructor', bySelf: 'Student',
      byAdminRent: 'Instructor',
      sheets: ['Summary', 'Bookings', 'Rentals', 'By student'],
      sum: ['Period', 'Student', 'Bookings (excl. cancelled)', 'Attended', 'Upcoming', 'Cancelled by student', 'Class cancelled',
        'No credit used (may need payment)', 'Rentals (excl. cancelled)', 'Rental amount', 'Paid', 'Unpaid'],
    },
  };

  /** 依期間（含結束日）與學員整理報表資料。 */
  function buildReport(url) {
    const from = url.searchParams.get('from'), to = url.searchParams.get('to');
    if (!T.isValidDate(from) || !T.isValidDate(to)) throw new HttpError(400, '請選擇正確的開始與結束日期');
    if (to < from) throw new HttpError(400, '結束日期不能早於開始日期');
    if (T.minutesBetween(`${from}T00:00`, `${to}T00:00`) > 400 * 1440) throw new HttpError(400, '一次最多匯出 400 天');
    const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'zh', t = L[lang];
    const sid = url.searchParams.get('studentId') ? Number(url.searchParams.get('studentId')) : null;
    const student = sid ? store.getStudent(sid) : null;
    if (sid && !student) throw new HttpError(404, '找不到這位學員');
    const end = T.addDays(to, 1), nowT = now();
    const dowOf = (d) => t.dow[T.weekday(d)];
    const typeName = (k) => (lang === 'en' ? R.RENTAL_TYPES[k].nameEn : R.RENTAL_TYPES[k].name);

    const bookings = store.reportBookings(from, end, sid).map((b) => {
      const status = b.status === 'cancelled' ? 'cancelled' : b.slot_cancelled ? 'slotCancelled'
        : b.start_at <= nowT ? 'attended' : 'booked';
      const endT = T.fromMs(T.toMs(b.start_at) + b.duration_min * 60000).slice(11);
      return {
        studentId: b.student_id, status, noPass: status !== 'cancelled' && status !== 'slotCancelled' && !b.pass_name && !b.trial,
        row: [b.start_at.slice(0, 10), dowOf(b.start_at.slice(0, 10)), `${b.start_at.slice(11)}–${endT}`,
          (lang === 'en' && b.title_en) || b.title, b.name, b.email, b.phone, t.st[status],
          b.pass_name ? b.pass_name + (b.pass_unlimited ? t.unlimited : '') : (b.trial || status === 'cancelled' || status === 'slotCancelled' ? '' : t.noPass),
          b.trial ? t.yes : '', b.booked_by === 'admin' ? t.byAdmin : t.bySelf, b.note],
      };
    });
    const rentals = store.reportRentals(from, end, sid).map((r) => {
      const status = r.status === 'cancelled' ? 'rentCancelled' : `${r.date}T${r.start}` <= nowT ? 'used' : 'booked';
      return {
        studentId: r.student_id, status, price: r.pass_name ? 0 : r.price, paid: !!r.paid,   // 扣時數的不算現金
        row: [r.date, dowOf(r.date), `${r.start}–${r.end}`, (R.toMin(r.end) - R.toMin(r.start)) / 60, typeName(r.type),
          r.contact_name, r.contact_phone, r.people, r.price, r.pass_name ? '' : (r.paid ? t.paid : t.unpaid),
          r.pass_name || '', r.pass_name ? r.units : '', t.st[status],
          r.booked_by === 'admin' ? t.byAdminRent : t.bySelf, r.note],
        email: r.student_email || '',
      };
    });
    const live = bookings.filter((b) => b.status !== 'cancelled' && b.status !== 'slotCancelled');
    const liveR = rentals.filter((r) => r.status !== 'rentCancelled');
    const count = (arr, st) => arr.filter((x) => x.status === st).length;
    const sumR = (arr) => arr.reduce((n, r) => n + r.price, 0);
    const summary = [
      [t.sum[0], `${from} ~ ${to}`],
      [t.sum[1], student ? `${student.name} <${student.email}>` : t.all],
      [t.sum[2], live.length], [t.sum[3], count(bookings, 'attended')], [t.sum[4], count(bookings, 'booked')],
      [t.sum[5], count(bookings, 'cancelled')], [t.sum[6], count(bookings, 'slotCancelled')],
      [t.sum[7], bookings.filter((b) => b.noPass).length],
      [t.sum[8], liveR.length], [t.sum[9], sumR(liveR)], [t.sum[10], sumR(liveR.filter((r) => r.paid))],
      [t.sum[11], sumR(liveR.filter((r) => !r.paid))],
    ];
    // 學員統計（沒有指定學員時）
    const per = new Map();
    for (const b of bookings) {
      const k = b.studentId;
      const o = per.get(k) || per.set(k, { name: b.row[4], email: b.row[5], attended: 0, booked: 0, cancelled: 0, slotCancelled: 0, noPass: 0, rentals: 0, amount: 0 }).get(k);
      o[b.status] += 1;
      if (b.noPass) o.noPass += 1;
    }
    for (const r of liveR) {
      if (!r.studentId) continue;
      const o = per.get(r.studentId) || per.set(r.studentId, { name: r.row[5], email: r.email, attended: 0, booked: 0, cancelled: 0, slotCancelled: 0, noPass: 0, rentals: 0, amount: 0 }).get(r.studentId);
      o.rentals += 1; o.amount += r.price;
    }
    const perStudent = [...per.values()].sort((a, b) => a.name.localeCompare(b.name))
      .map((o) => [o.name, o.email, o.attended, o.booked, o.cancelled, o.slotCancelled, o.noPass, o.rentals, o.amount]);
    return { lang, t, from, to, student, summary, bookings: bookings.map((b) => b.row), rentals: rentals.map((r) => r.row), perStudent };
  }

  // 所有預約：上課預約＋場地租借，可依期間、類型、狀態、關鍵字篩選
  route('GET', /^\/api\/admin\/all-bookings$/, (req, url) => {
    requireAdmin(req);
    const from = url.searchParams.get('from'), to = url.searchParams.get('to');
    if (!T.isValidDate(from) || !T.isValidDate(to)) throw new HttpError(400, '請選擇正確的開始與結束日期');
    if (to < from) throw new HttpError(400, '結束日期不能早於開始日期');
    if (T.minutesBetween(`${from}T00:00`, `${to}T00:00`) > 400 * 1440) throw new HttpError(400, '一次最多查詢 400 天');
    const kind = url.searchParams.get('kind') || 'all';        // all / class / rental
    const status = url.searchParams.get('status') || 'all';    // all / active / booked / attended / cancelled / slotCancelled
    const kw = (url.searchParams.get('q') || '').trim().toLowerCase();
    const end = T.addDays(to, 1), nowT = now();
    const items = [];
    if (kind !== 'rental') {
      for (const b of store.reportBookings(from, end, null)) {
        const st = b.status === 'cancelled' ? 'cancelled' : b.slot_cancelled ? 'slotCancelled' : b.start_at <= nowT ? 'attended' : 'booked';
        items.push({
          kind: 'class', id: b.id, date: b.start_at.slice(0, 10), start: b.start_at.slice(11),
          end: T.fromMs(T.toMs(b.start_at) + b.duration_min * 60000).slice(11),
          title: b.title, titleEn: b.title_en, category: b.category, studentId: b.student_id, name: b.name, email: b.email,
          phone: b.phone, status: st, passName: b.pass_name, passUnlimited: !!b.pass_unlimited, trial: !!b.trial,
          bookedBy: b.booked_by, note: b.note, createdAt: b.created_at, cancelledAt: b.cancelled_at,
        });
      }
    }
    if (kind !== 'class') {
      for (const r of store.reportRentals(from, end, null)) {
        const st = r.status === 'cancelled' ? 'cancelled' : `${r.date}T${r.start}` <= nowT ? 'attended' : 'booked';
        items.push({
          kind: 'rental', id: r.id, date: r.date, start: r.start, end: r.end, rentalType: r.type, people: r.people,
          studentId: r.student_id, name: r.contact_name, email: r.student_email || '', phone: r.contact_phone,
          status: st, passName: r.pass_name, units: r.units, price: r.price, paid: !!r.paid,
          bookedBy: r.booked_by, note: r.note, createdAt: r.created_at, cancelledAt: r.cancelled_at,
        });
      }
    }
    const wanted = (it) => status === 'all' || (status === 'active' ? ['booked', 'attended'].includes(it.status) : it.status === status);
    const typeName = (it) => (it.kind === 'rental' ? R.RENTAL_TYPES[it.rentalType].name : `${it.title} ${it.titleEn || ''}`);
    const match = (it) => !kw || [it.name, it.email, it.phone, typeName(it), it.passName, it.note]
      .some((v) => String(v || '').toLowerCase().includes(kw));
    const list = items.filter((it) => wanted(it) && match(it))
      .sort((x, y) => `${x.date}${x.start}`.localeCompare(`${y.date}${y.start}`) || String(x.name).localeCompare(String(y.name)));
    const count = (st) => list.filter((x) => x.status === st).length;
    return {
      total: list.length,
      counts: { booked: count('booked'), attended: count('attended'), cancelled: count('cancelled'), slotCancelled: count('slotCancelled'),
        classes: list.filter((x) => x.kind === 'class').length, rentals: list.filter((x) => x.kind === 'rental').length },
      items: list.slice(0, 2000), truncated: list.length > 2000,
    };
  });

  route('GET', /^\/api\/admin\/report$/, (req, url) => {
    requireAdmin(req);
    const r = buildReport(url);
    return {
      from: r.from, to: r.to, student: r.student && publicStudent(r.student), summary: r.summary,
      headers: { bookings: r.t.booking, rentals: r.t.rental, perStudent: r.t.perStudent }, sheets: r.t.sheets,
      bookings: r.bookings, rentals: r.rentals, perStudent: r.perStudent,
    };
  });

  route('GET', /^\/api\/admin\/report\.xlsx$/, (req, url) => {
    requireAdmin(req);
    const r = buildReport(url);
    const sheets = [
      { name: r.t.sheets[0], rows: [[r.lang === 'en' ? 'Item' : '項目', r.lang === 'en' ? 'Value' : '數值'], ...r.summary], widths: [30, 36] },
      { name: r.t.sheets[1], rows: [r.t.booking, ...r.bookings], widths: [12, 6, 13, 22, 12, 26, 13, 10, 18, 8, 10, 24] },
      { name: r.t.sheets[2], rows: [r.t.rental, ...r.rentals], widths: [12, 6, 13, 7, 12, 14, 13, 7, 9, 9, 18, 9, 9, 10, 24] },
    ];
    if (!r.student) sheets.push({ name: r.t.sheets[3], rows: [r.t.perStudent, ...r.perStudent], widths: [14, 26, 9, 12, 10, 10, 9, 12, 12] });
    const who = r.student ? `_${r.student.name}` : '';
    return { file: buildXlsx(sheets), filename: `${cfg.schoolName}_${r.from}_${r.to}${who}.xlsx`,
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  });

  // ----- 寄信設定（忘記密碼用） -----
  route('GET', /^\/api\/admin\/mail-status$/, (req) => {
    requireAdmin(req);
    return { enabled: mailer.enabled, from: cfg.mailFrom, publicUrl: cfg.publicUrl, detectedUrl: baseUrl(req) };
  });

  route('POST', /^\/api\/admin\/mail-test$/, async (req, url, body) => {
    requireAdmin(req);
    if (!mailer.enabled) throw new HttpError(409, '尚未設定 RESEND_API_KEY 和 MAIL_FROM');
    const to = normEmail(body.to);
    try {
      await mailer.send({
        to,
        subject: `${cfg.schoolName}｜測試信 Test email`,
        text: `這是 ${cfg.schoolName} 約課網站的測試信，收到代表「忘記密碼」寄信設定成功。\n\nThis is a test email from ${cfg.schoolNameEn}.`,
        html: `<p>這是 ${cfg.schoolName} 約課網站的測試信，收到代表「忘記密碼」寄信設定成功。</p><p>This is a test email from ${cfg.schoolNameEn}.</p>`,
      });
    } catch (e) {
      throw new HttpError(502, `寄信失敗：${e.message}`);
    }
    return { ok: true };
  });

  // ----- 學員資料 -----
  // 產生設定／重設密碼連結（老師用 LINE 等方式傳給學員）
  route('POST', /^\/api\/admin\/students\/(\d+)\/reset-link$/, (req, url, body, [, id]) => {
    requireAdmin(req);
    const st = store.getStudent(Number(id));
    if (!st) throw new HttpError(404, '找不到這位學員');
    const token = store.createReset(st.email, ADMIN_RESET_DAYS * 86400e3);
    return { url: `${baseUrl(req)}/reset?token=${token}`, days: ADMIN_RESET_DAYS, email: st.email };
  });

  route('POST', /^\/api\/admin\/students\/(\d+)\/photo-consent$/, (req, url, body, [, id]) => {
    requireAdmin(req);
    if (!['yes', 'no', ''].includes(body.value)) throw new HttpError(400, '資料格式錯誤');
    if (!store.setPhotoConsent(Number(id), body.value)) throw new HttpError(404, '找不到這位學員');
    return { ok: true };
  });

  route('GET', /^\/api\/admin\/students$/, (req) => {
    requireAdmin(req);
    const summary = store.passSummary(today());
    return {
      students: store.listStudents(now()).map((st) => ({
        credits: summary[st.id] || { remaining: 0, nextExpiry: null, future: 0, unlimited: false, unlimitedUntil: null,
          rental: { remaining: 0, nextExpiry: null, future: 0, unlimited: false, unlimitedUntil: null } },
        ...publicStudent(st), note: st.note, birthday: st.birthday, active: !!st.active, createdAt: st.created_at, lastLogin: st.last_login,
        gender: st.gender, healthNotes: st.health_notes, consentPrivacyAt: st.consent_privacy_at, consentPhoto: st.consent_photo,
        source: st.source, hasPassword: !!store.getAccount(st.email),
        upcoming: st.upcoming, attended: st.attended, lastClass: st.last_class,
      })),
    };
  });

  route('POST', /^\/api\/admin\/students$/, (req, url, body) => {
    requireAdmin(req);
    const input = parseStudent(body);
    if (store.findStudent(input.email, input.name)) {
      throw new HttpError(409, `信箱 ${input.email} 底下已經有同名學員「${input.name}」`);
    }
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
    // 同一信箱可以有多位學員，但同一信箱不能出現兩次同樣的姓名
    const seen = new Set();
    for (const it of items) {
      const key = `${it.email}\n${it.name.toLowerCase()}`;
      if (seen.has(key)) throw new HttpError(400, `重複：${it.name} <${it.email}>`);
      seen.add(key);
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
    return { passes: store.listPasses(Number(id)).map((p) => ({ ...publicPass(p), logs: store.passLogs(p.id) })) };
  });

  route('POST', /^\/api\/admin\/students\/(\d+)\/passes$/, (req, url, body, [, id]) => {
    requireAdmin(req);
    if (!store.getStudent(Number(id))) throw new HttpError(404, '找不到這位學員');
    const input = parsePass(body);
    // 開卡時可以先填已用堂數（例如補登紙本紀錄）
    const used = body.used === undefined || body.used === '' ? 0
      : input.kind === 'rental' ? halfHours(body.used, 0, input.unlimited ? 9999 : input.total, '已使用時數')
        : int(body.used, 0, input.unlimited ? 9999 : input.total, '已使用堂數');
    const pid = store.createPass(Number(id), { ...input, adjust: used });
    store.logPass(pid, 'create', { name: input.name, kind: input.kind, total: input.total, unlimited: input.unlimited, end: input.endDate, used,
      purchase: input.purchaseDate });
    return { status: 201, body: { id: pid } };
  });

  route('PUT', /^\/api\/admin\/passes\/(\d+)$/, (req, url, body, [, id]) => {
    requireAdmin(req);
    const p = store.getPass(Number(id));
    if (!p) throw new HttpError(404, '找不到這張堂數卡');
    const input = parsePass({ ...body, kind: p.kind });   // 卡種開卡後不能改
    // 「已使用堂數」可直接修改：和系統預約扣的堂數之間的差額記成手動調整
    const used = body.used === undefined || body.used === '' ? p.used
      : input.kind === 'rental' ? halfHours(body.used, 0, 9999, '已使用時數') : int(body.used, 0, 500, '已使用堂數');
    if (!input.unlimited && input.total < used) throw new HttpError(409, `已經用了 ${used} 堂，總堂數不能少於這個數字`);
    store.updatePass(p.id, { ...input, adjust: used - p.booked_used });
    // 記下改了哪些欄位（更改方案、展延、補登等）
    const before = { name: p.name, unlimited: !!p.unlimited, total: p.total, start: p.start_date, end: p.end_date, purchase: p.purchase_date,
      categories: p.categories, used: p.used };
    const afterV = { name: input.name, unlimited: input.unlimited, total: input.total, start: input.startDate, end: input.endDate,
      purchase: input.purchaseDate, categories: input.categories, used };
    const changes = Object.keys(before).filter((k) => String(before[k]) !== String(afterV[k]))
      .map((k) => [k, before[k], afterV[k]]);
    if (changes.length) store.logPass(p.id, 'edit', { changes });
    return { ok: true };
  });

  // 展延：只改到期日
  route('POST', /^\/api\/admin\/passes\/(\d+)\/extend$/, (req, url, body, [, id]) => {
    requireAdmin(req);
    const p = store.getPass(Number(id));
    if (!p) throw new HttpError(404, '找不到這張堂數卡');
    if (!T.isValidDate(body.endDate)) throw new HttpError(400, '日期格式錯誤');
    if (body.endDate < p.start_date) throw new HttpError(400, '到期日不能早於開始日');
    store.setPassEnd(p.id, body.endDate);
    store.logPass(p.id, 'extend', { from: p.end_date, to: body.endDate, reason: str(body.reason, 100, '原因', { required: false }) });
    return { ok: true, pass: publicPass(store.getPass(p.id)) };
  });

  // 快速扣 1 堂／補回 1 堂（例如學員沒預約直接來上課）
  route('POST', /^\/api\/admin\/passes\/(\d+)\/adjust$/, (req, url, body, [, id]) => {
    requireAdmin(req);
    const p = store.getPass(Number(id));
    if (!p) throw new HttpError(404, '找不到這張堂數卡');
    const delta = p.kind === 'rental' ? Number(body.delta) : int(body.delta, -100, 100, '調整堂數');
    if (p.kind === 'rental' && !(Number.isFinite(delta) && Math.abs(delta) <= 100 && Math.round(delta * 2) === delta * 2 && delta)) {
      throw new HttpError(400, '調整時數需以 0.5 為單位');
    }
    const used = p.used + delta;
    if (!p.unlimited && used > p.total) throw new HttpError(409, '堂數已經用完了，無法再扣');
    if (used < 0) throw new HttpError(409, '已使用堂數不能小於 0');
    store.setPassAdjust(p.id, p.adjust + delta);
    store.logPass(p.id, 'adjust', { delta, used });
    return { ok: true, pass: publicPass(store.getPass(p.id)) };
  });

  route('POST', /^\/api\/admin\/passes\/(\d+)\/(void|restore)$/, (req, url, body, [, id, act]) => {
    requireAdmin(req);
    if (!store.setPassVoided(Number(id), act === 'void')) throw new HttpError(404, '找不到這張堂數卡');
    store.logPass(Number(id), act);
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
    const other = store.findStudent(input.email, input.name);
    if (other && other.id !== Number(id)) {
      throw new HttpError(409, `信箱 ${input.email} 底下已經有同名學員「${input.name}」`);
    }
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
    if (r === false) throw new HttpError(409, '這位學員有預約、堂數或租借紀錄，無法刪除，請改用「停用」');
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
          healthNotes: b.health_notes, consentPhoto: b.consent_photo,
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
        const out = await r.handler(req, url, body, m);
        if (out && out.file) {
          res.writeHead(200, {
            'Content-Type': out.type, 'Cache-Control': 'no-store',
            'Content-Disposition': `attachment; filename="report.xlsx"; filename*=UTF-8''${encodeURIComponent(out.filename)}`,
          });
          return res.end(out.file);
        }
        if (out && out.status) return send(res, out.status, out.body);
        return send(res, 200, out);
      }
      throw new HttpError(matchedPath ? 405 : 404, matchedPath ? 'Method Not Allowed' : '找不到這個 API');
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...(e.code ? { code: e.code } : {}) });
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
