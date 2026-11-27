'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;`);
  const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

  // 舊版（用電話＋預約代碼）的預約表改名保留，改用學員帳號
  if (cols('bookings').includes('code')) {
    db.exec(`
      DROP INDEX IF EXISTS idx_bookings_slot;
      DROP INDEX IF EXISTS idx_bookings_phone;
      ALTER TABLE bookings RENAME TO bookings_legacy;
    `);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS templates (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      title        TEXT    NOT NULL,
      subtitle     TEXT    NOT NULL DEFAULT '',
      category     TEXT    NOT NULL DEFAULT 'other',
      weekday      INTEGER NOT NULL,             -- 0 = 週日
      time         TEXT    NOT NULL,             -- 'HH:MM'
      duration_min INTEGER NOT NULL,
      capacity     INTEGER NOT NULL,
      note         TEXT    NOT NULL DEFAULT '',
      created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS slots (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      title        TEXT    NOT NULL,
      start_at     TEXT    NOT NULL,            -- 當地時間 'YYYY-MM-DDTHH:MM'
      duration_min INTEGER NOT NULL,
      capacity     INTEGER NOT NULL,
      note         TEXT    NOT NULL DEFAULT '',
      created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS students (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    NOT NULL,
      email        TEXT    NOT NULL COLLATE NOCASE,    -- 同一個信箱可以有多位學員（例如兄弟姊妹）
      phone        TEXT    NOT NULL DEFAULT '',
      note         TEXT    NOT NULL DEFAULT '',   -- 老師的備註（學員看不到）
      active       INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      last_login   TEXT
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      slot_id      INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
      student_id   INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      note         TEXT    NOT NULL DEFAULT '',
      trial        INTEGER NOT NULL DEFAULT 0,
      booked_by    TEXT    NOT NULL DEFAULT 'student',  -- student | admin
      status       TEXT    NOT NULL DEFAULT 'active',   -- active | cancelled
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      cancelled_at TEXT
    );
    CREATE TABLE IF NOT EXISTS passes (                -- 堂數卡
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id   INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      name         TEXT    NOT NULL,
      total        INTEGER NOT NULL,              -- 總堂數
      start_date   TEXT    NOT NULL,              -- 'YYYY-MM-DD'（含）
      end_date     TEXT    NOT NULL,              -- 'YYYY-MM-DD'（含）
      categories   TEXT    NOT NULL DEFAULT '',   -- 適用課程分類，逗號分隔；空白 = 全部
      note         TEXT    NOT NULL DEFAULT '',
      voided       INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash   TEXT    PRIMARY KEY,
      role         TEXT    NOT NULL,            -- admin | student
      student_id   INTEGER REFERENCES students(id) ON DELETE CASCADE,
      expires_at   INTEGER NOT NULL
    );
  `);
  const addCol = (table, col, def) => {
    if (!cols(table).includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  };
  addCol('slots', 'subtitle', "TEXT NOT NULL DEFAULT ''");
  addCol('slots', 'category', "TEXT NOT NULL DEFAULT 'other'");
  addCol('slots', 'template_id', 'INTEGER REFERENCES templates(id) ON DELETE SET NULL');
  addCol('slots', 'cancelled', 'INTEGER NOT NULL DEFAULT 0');   // 1 = 停課
  // 英文課名／英文副標題（中英切換用）
  if (!cols('templates').includes('title_en')) {
    for (const t of ['templates', 'slots']) {
      addCol(t, 'title_en', "TEXT NOT NULL DEFAULT ''");
      addCol(t, 'subtitle_en', "TEXT NOT NULL DEFAULT ''");
    }
    migrateEnglishNames(db);
  }
  addCol('students', 'birthday', "TEXT NOT NULL DEFAULT ''");     // 'YYYY-MM-DD'，可空白
  if (!cols('passes').includes('purchase_date')) {
    addCol('passes', 'purchase_date', "TEXT NOT NULL DEFAULT ''");  // 購買日 'YYYY-MM-DD'
    db.exec(`UPDATE passes SET purchase_date = date(created_at, '+8 hours') WHERE purchase_date = ''`);
  }
  addCol('bookings', 'pass_id', 'INTEGER REFERENCES passes(id) ON DELETE SET NULL'); // 扣哪張卡
  addCol('passes', 'unlimited', 'INTEGER NOT NULL DEFAULT 0'); // 1 = 無限堂（有效期間內不限堂數）
  addCol('passes', 'adjust', 'INTEGER NOT NULL DEFAULT 0'); // 手動調整的已用堂數（補登紙本、現場上課未預約等）
  db.exec(`
    CREATE TABLE IF NOT EXISTS pass_logs (           -- 堂數卡異動紀錄
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      pass_id    INTEGER NOT NULL REFERENCES passes(id) ON DELETE CASCADE,
      action     TEXT    NOT NULL,                   -- create / edit / extend / adjust / void / restore
      detail     TEXT    NOT NULL DEFAULT '{}',      -- JSON
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pass_logs ON pass_logs(pass_id);
    CREATE TABLE IF NOT EXISTS rentals (             -- 場地租借
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id    INTEGER REFERENCES students(id) ON DELETE SET NULL,  -- 學員自己租；老師代訂可以沒有
      contact_name  TEXT    NOT NULL,
      contact_phone TEXT    NOT NULL DEFAULT '',
      type          TEXT    NOT NULL,                -- group 團體課程 / private 一對一 / self 自主訓練
      date          TEXT    NOT NULL,                -- 'YYYY-MM-DD'
      start         TEXT    NOT NULL,                -- 'HH:MM'
      end           TEXT    NOT NULL,
      people        INTEGER NOT NULL DEFAULT 1,
      price         INTEGER NOT NULL,
      note          TEXT    NOT NULL DEFAULT '',
      paid          INTEGER NOT NULL DEFAULT 0,
      booked_by     TEXT    NOT NULL DEFAULT 'student',
      status        TEXT    NOT NULL DEFAULT 'active', -- active / cancelled
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      cancelled_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_rentals_date ON rentals(date);
    CREATE INDEX IF NOT EXISTS idx_rentals_student ON rentals(student_id);
  `);
  // 場地租借時數卡：passes.kind = 'rental'，以小時計；租借扣的時數記在 rentals.units
  addCol('passes', 'kind', "TEXT NOT NULL DEFAULT 'class'");        // class 上課堂數 / rental 場地租借時數
  addCol('rentals', 'pass_id', 'INTEGER REFERENCES passes(id) ON DELETE SET NULL');
  addCol('rentals', 'units', 'REAL NOT NULL DEFAULT 0');           // 扣了幾小時（自主訓練 = 人數 × 小時）
  addCol('bookings', 'attendance', "TEXT NOT NULL DEFAULT ''");     // 點名：'' 未點（視為出席）、absent 缺席
  allowSharedEmails(db, cols);
  // 學員自行註冊的資料
  addCol('students', 'gender', "TEXT NOT NULL DEFAULT ''");            // M 男、F 女、X 其他／不透露
  addCol('students', 'health_notes', "TEXT NOT NULL DEFAULT ''");      // 須留意的身心狀況
  addCol('students', 'consent_privacy_at', "TEXT NOT NULL DEFAULT ''"); // 同意個資蒐集的時間
  addCol('students', 'consent_photo', "TEXT NOT NULL DEFAULT ''");      // yes 同意攝影使用、no 不同意、'' 未填
  addCol('students', 'consent_version', "TEXT NOT NULL DEFAULT ''");
  addCol('students', 'source', "TEXT NOT NULL DEFAULT 'admin'");        // admin 老師建立、self 自行註冊
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (            -- 登入密碼（同一個信箱的學員共用）
      email         TEXT PRIMARY KEY COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS password_resets (
      token_hash    TEXT PRIMARY KEY,
      email         TEXT NOT NULL COLLATE NOCASE,
      expires_at    INTEGER NOT NULL,
      used          INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_slots_start ON slots(start_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_slots_tpl ON slots(template_id, start_at) WHERE template_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_bookings_slot    ON bookings(slot_id);
    CREATE INDEX IF NOT EXISTS idx_bookings_student ON bookings(student_id);
    CREATE INDEX IF NOT EXISTS idx_bookings_pass    ON bookings(pass_id);
    CREATE INDEX IF NOT EXISTS idx_passes_student   ON passes(student_id);
    CREATE INDEX IF NOT EXISTS idx_students_email   ON students(email);
  `);
  return db;
}

// 已使用 = 系統扣的（上課：有效預約、且那堂課沒有停課；場地：有效租借的時數；取消或停課會自動退回）＋ 手動調整
const BOOKED_USED = `((SELECT COUNT(*) FROM bookings b JOIN slots s ON s.id = b.slot_id
  WHERE b.pass_id = p.id AND b.status = 'active' AND s.cancelled = 0)
  + (SELECT COALESCE(SUM(r.units), 0) FROM rentals r WHERE r.pass_id = p.id AND r.status = 'active'))`;
const USED = `(${BOOKED_USED} + p.adjust)`;
const PASS_COLS = `p.*, ${BOOKED_USED} AS booked_used, ${USED} AS used`;

/** 堂數卡狀態：void 作廢、future 未開始、expired 已過期、used 已用完、active 使用中 */
function passStatus(p, today) {
  if (p.voided) return 'void';
  if (today < p.start_date) return 'future';
  if (today > p.end_date) return 'expired';
  if (!p.unlimited && p.used >= p.total) return 'used';
  return 'active';
}

/**
 * 某堂課可以用哪張卡：未作廢、在有效期限內（以上課日期判斷）、還有剩、適用這類課程。
 * 優先用無限堂（一般卡的堂數才不會被浪費），其次是最快到期的。
 */
function pickPass(passes, slot) {
  const date = slot.start_at.slice(0, 10);
  return passes
    .filter((p) => p.kind !== 'rental' && !p.voided && p.start_date <= date && date <= p.end_date && (p.unlimited || p.used < p.total)
      && (!p.categories || p.categories.split(',').includes(slot.category)))
    .sort((a, b) => b.unlimited - a.unlimited || a.end_date.localeCompare(b.end_date) || a.id - b.id)[0] || null;
}

/**
 * 場地租借可以用哪張場租卡：未作廢、租借日期在有效期內、適用這種租借、剩餘時數夠用。
 * 優先用無限時數，其次是最快到期的。
 */
function pickRentalPass(passes, rental) {
  return passes
    .filter((p) => p.kind === 'rental' && !p.voided && p.start_date <= rental.date && rental.date <= p.end_date
      && (p.unlimited || p.total - p.used >= rental.units - 1e-9)
      && (!p.categories || p.categories.split(',').includes(rental.type)))
    .sort((a, b) => b.unlimited - a.unlimited || a.end_date.localeCompare(b.end_date) || a.id - b.id)[0] || null;
}

/**
 * 舊版把英文名稱寫在副標題裡（例如「Taekwon-Do・12歲以上」），升級時拆成英文課名與中英副標題。
 */
const AGE_EN = { '12歲以上': 'Age 12+', '3至6歲': 'Age 3–6', '8至12歲': 'Age 8–12', '進階班': 'Advanced' };
function migrateEnglishNames(db) {
  for (const table of ['templates', 'slots']) {
    const rows = db.prepare(`SELECT id, subtitle FROM ${table} WHERE title_en = '' AND subtitle != ''`).all();
    const upd = db.prepare(`UPDATE ${table} SET title_en = ?, subtitle = ?, subtitle_en = ? WHERE id = ?`);
    for (const r of rows) {
      const [first, ...rest] = r.subtitle.split('・');
      if (!/^[\x20-\x7E]+$/.test(first)) continue;            // 第一段不是英文就不動
      const zh = rest.join('・');
      upd.run(first.trim(), zh, AGE_EN[zh] || '', r.id);
    }
  }
}

/** 舊版學員信箱設為不可重複；重建 students 表拿掉這個限制（資料、編號都保留）。 */
function allowSharedEmails(db, cols) {
  const { sql } = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'students'`).get();
  if (!/email\s+TEXT\s+NOT NULL\s+UNIQUE/i.test(sql)) return;
  const keep = cols('students').join(', ');
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec(`BEGIN;
      CREATE TABLE students_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE,
        phone TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login TEXT, birthday TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO students_new (${keep}) SELECT ${keep} FROM students;
      DROP TABLE students;
      ALTER TABLE students_new RENAME TO students;
      COMMIT;`);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

const BOOKED = `(SELECT COUNT(*) FROM bookings b WHERE b.slot_id = s.id AND b.status = 'active')`;

function createStore(db) {
  const q = {
    slotsBetween: db.prepare(`SELECT s.*, ${BOOKED} AS booked FROM slots s
      WHERE s.start_at >= ? AND s.start_at < ? ORDER BY s.start_at, s.id`),
    slotById: db.prepare(`SELECT s.*, ${BOOKED} AS booked FROM slots s WHERE s.id = ?`),
    insertSlot: db.prepare(`INSERT INTO slots (title, subtitle, category, start_at, duration_min, capacity, note, title_en, subtitle_en)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insertTplSlot: db.prepare(`INSERT OR IGNORE INTO slots
      (title, subtitle, category, start_at, duration_min, capacity, note, template_id, title_en, subtitle_en)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updateSlot: db.prepare(`UPDATE slots SET title = ?, subtitle = ?, category = ?, start_at = ?, duration_min = ?,
      capacity = ?, note = ?, title_en = ?, subtitle_en = ? WHERE id = ?`),
    setCancelled: db.prepare(`UPDATE slots SET cancelled = ? WHERE id = ?`),
    deleteSlot: db.prepare(`DELETE FROM slots WHERE id = ?`),

    templates: db.prepare(`SELECT * FROM templates ORDER BY (weekday + 6) % 7, time, id`),
    templateById: db.prepare(`SELECT * FROM templates WHERE id = ?`),
    countTemplates: db.prepare(`SELECT COUNT(*) AS n FROM templates`),
    countSlots: db.prepare(`SELECT COUNT(*) AS n FROM slots`),
    insertTemplate: db.prepare(`INSERT INTO templates (title, subtitle, category, weekday, time, duration_min, capacity, note,
      title_en, subtitle_en) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updateTemplate: db.prepare(`UPDATE templates SET title = ?, subtitle = ?, category = ?, duration_min = ?,
      capacity = ?, note = ?, title_en = ?, subtitle_en = ? WHERE id = ?`),
    propagateTemplate: db.prepare(`UPDATE slots SET title = ?, subtitle = ?, category = ?, duration_min = ?, note = ?,
      title_en = ?, subtitle_en = ?,
      capacity = MAX(?, (SELECT COUNT(*) FROM bookings b WHERE b.slot_id = slots.id AND b.status = 'active'))
      WHERE template_id = ? AND start_at >= ?`),
    deleteFutureEmpty: db.prepare(`DELETE FROM slots WHERE template_id = ? AND start_at >= ?
      AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id = slots.id AND b.status = 'active')`),
    countFutureTpl: db.prepare(`SELECT COUNT(*) AS n FROM slots WHERE template_id = ? AND start_at >= ?`),
    deleteTemplate: db.prepare(`DELETE FROM templates WHERE id = ?`),

    // 學員
    students: db.prepare(`
      SELECT st.*,
        (SELECT COUNT(*) FROM bookings b JOIN slots s ON s.id = b.slot_id
          WHERE b.student_id = st.id AND b.status = 'active' AND s.cancelled = 0 AND s.start_at >= ?) AS upcoming,
        (SELECT COUNT(*) FROM bookings b JOIN slots s ON s.id = b.slot_id
          WHERE b.student_id = st.id AND b.status = 'active' AND s.cancelled = 0 AND s.start_at < ?) AS attended,
        (SELECT MAX(s.start_at) FROM bookings b JOIN slots s ON s.id = b.slot_id
          WHERE b.student_id = st.id AND b.status = 'active' AND s.cancelled = 0 AND s.start_at < ?) AS last_class
      FROM students st ORDER BY st.active DESC, st.name COLLATE NOCASE, st.id`),
    studentById: db.prepare(`SELECT * FROM students WHERE id = ?`),
    studentsByEmail: db.prepare(`SELECT * FROM students WHERE email = ? ORDER BY id`),
    studentByEmailName: db.prepare(`SELECT * FROM students WHERE email = ? AND name = ? COLLATE NOCASE`),
    insertStudent: db.prepare(`INSERT INTO students (name, email, phone, note, birthday, gender, health_notes,
      consent_privacy_at, consent_photo, consent_version, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updateStudent: db.prepare(`UPDATE students SET name = ?, email = ?, phone = ?, note = ?, birthday = ?, gender = ?,
      health_notes = ? WHERE id = ?`),
    setPhotoConsent: db.prepare(`UPDATE students SET consent_photo = ? WHERE id = ?`),

    // 密碼
    account: db.prepare(`SELECT * FROM accounts WHERE email = ?`),
    upsertAccount: db.prepare(`INSERT INTO accounts (email, password_hash) VALUES (?, ?)
      ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, updated_at = datetime('now')`),
    insertReset: db.prepare(`INSERT INTO password_resets (token_hash, email, expires_at) VALUES (?, ?, ?)`),
    reset: db.prepare(`SELECT * FROM password_resets WHERE token_hash = ?`),
    useReset: db.prepare(`UPDATE password_resets SET used = 1 WHERE email = ?`),
    purgeResets: db.prepare(`DELETE FROM password_resets WHERE expires_at < ?`),
    deleteEmailSessions: db.prepare(`DELETE FROM sessions WHERE role = 'student'
      AND student_id IN (SELECT id FROM students WHERE email = ?)`),
    setStudentActive: db.prepare(`UPDATE students SET active = ? WHERE id = ?`),
    deleteStudent: db.prepare(`DELETE FROM students WHERE id = ?`),
    countStudentBookings: db.prepare(`SELECT (SELECT COUNT(*) FROM bookings WHERE student_id = ?1)
      + (SELECT COUNT(*) FROM passes WHERE student_id = ?1) + (SELECT COUNT(*) FROM rentals WHERE student_id = ?1) AS n`),
    touchLogin: db.prepare(`UPDATE students SET last_login = datetime('now')
      WHERE email = (SELECT email FROM students WHERE id = ?)`),

    // 堂數卡
    passesByStudent: db.prepare(`SELECT ${PASS_COLS} FROM passes p WHERE p.student_id = ?
      ORDER BY p.voided, p.end_date DESC, p.id DESC`),
    allPasses: db.prepare(`SELECT ${PASS_COLS} FROM passes p WHERE p.voided = 0 AND p.end_date >= ?`),
    passById: db.prepare(`SELECT ${PASS_COLS} FROM passes p WHERE p.id = ?`),
    insertPass: db.prepare(`INSERT INTO passes (student_id, name, total, start_date, end_date, categories, note, purchase_date, adjust,
      unlimited, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updatePass: db.prepare(`UPDATE passes SET name = ?, total = ?, start_date = ?, end_date = ?, categories = ?, note = ?,
      purchase_date = ?, adjust = ?, unlimited = ? WHERE id = ?`),
    setPassAdjust: db.prepare(`UPDATE passes SET adjust = ? WHERE id = ?`),
    setPassEnd: db.prepare(`UPDATE passes SET end_date = ? WHERE id = ?`),
    insertPassLog: db.prepare(`INSERT INTO pass_logs (pass_id, action, detail) VALUES (?, ?, ?)`),
    passLogs: db.prepare(`SELECT * FROM pass_logs WHERE pass_id = ? ORDER BY id DESC LIMIT 30`),
    setPassVoided: db.prepare(`UPDATE passes SET voided = ? WHERE id = ?`),
    countPassBookings: db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE pass_id = ?`),
    deletePass: db.prepare(`DELETE FROM passes WHERE id = ?`),

    // 報表匯出
    reportBookings: db.prepare(`
      SELECT b.id, b.status, b.trial, b.booked_by, b.note, b.created_at, b.cancelled_at, b.attendance,
             s.start_at, s.duration_min, s.title, s.title_en, s.category, s.cancelled AS slot_cancelled,
             st.id AS student_id, st.name, st.email, st.phone, p.name AS pass_name, p.unlimited AS pass_unlimited
      FROM bookings b JOIN slots s ON s.id = b.slot_id JOIN students st ON st.id = b.student_id
      LEFT JOIN passes p ON p.id = b.pass_id
      WHERE s.start_at >= ? AND s.start_at < ? AND (? IS NULL OR b.student_id = ?)
      ORDER BY s.start_at, st.name`),
    reportRentals: db.prepare(`
      SELECT r.*, st.name AS student_name, st.email AS student_email, p.name AS pass_name FROM rentals r
      LEFT JOIN students st ON st.id = r.student_id LEFT JOIN passes p ON p.id = r.pass_id
      WHERE r.date >= ? AND r.date < ? AND (? IS NULL OR r.student_id = ?)
      ORDER BY r.date, r.start, r.id`),

    // 場地租借
    rentalsOn: db.prepare(`SELECT * FROM rentals WHERE date = ? AND status = 'active' ORDER BY start, id`),
    rentalsBetween: db.prepare(`SELECT r.*, st.name AS student_name, st.email AS student_email, p.name AS pass_name FROM rentals r
      LEFT JOIN students st ON st.id = r.student_id LEFT JOIN passes p ON p.id = r.pass_id
      WHERE r.date >= ? AND r.date < ? ORDER BY r.date, r.start, r.id`),
    rentalById: db.prepare(`SELECT r.*, p.name AS pass_name FROM rentals r LEFT JOIN passes p ON p.id = r.pass_id WHERE r.id = ?`),
    rentalsByStudent: db.prepare(`SELECT r.*, p.name AS pass_name FROM rentals r LEFT JOIN passes p ON p.id = r.pass_id
      WHERE r.student_id = ? AND r.date >= ? ORDER BY r.date, r.start, r.id`),
    insertRental: db.prepare(`INSERT INTO rentals (student_id, contact_name, contact_phone, type, date, start, end, people, price,
      note, booked_by, pass_id, units) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    cancelRental: db.prepare(`UPDATE rentals SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ? AND status = 'active'`),
    setRentalPaid: db.prepare(`UPDATE rentals SET paid = ? WHERE id = ?`),
    slotsOnDay: db.prepare(`SELECT * FROM slots WHERE start_at >= ? AND start_at < ?`),

    // 登入
    insertSession: db.prepare(`INSERT INTO sessions (token_hash, role, student_id, expires_at) VALUES (?, ?, ?, ?)`),
    session: db.prepare(`SELECT * FROM sessions WHERE token_hash = ?`),
    deleteSession: db.prepare(`DELETE FROM sessions WHERE token_hash = ?`),
    purgeSessions: db.prepare(`DELETE FROM sessions WHERE expires_at < ?`),

    // 預約
    bookingsForSlot: db.prepare(`
      SELECT b.*, st.name, st.email, st.phone, st.birthday, st.health_notes, st.consent_photo, p.name AS pass_name FROM bookings b
      JOIN students st ON st.id = b.student_id LEFT JOIN passes p ON p.id = b.pass_id
      WHERE b.slot_id = ? ORDER BY b.status, b.created_at`),
    setAttendance: db.prepare(`UPDATE bookings SET attendance = ? WHERE id = ?`),
    // 某張卡的使用紀錄
    passUsageBookings: db.prepare(`
      SELECT b.id, b.status, b.attendance, b.trial, b.booked_by, b.created_at, s.start_at, s.duration_min, s.title, s.title_en,
             s.category, s.cancelled AS slot_cancelled, st.name
      FROM bookings b JOIN slots s ON s.id = b.slot_id JOIN students st ON st.id = b.student_id
      WHERE b.pass_id = ? ORDER BY s.start_at DESC, b.id DESC`),
    passUsageRentals: db.prepare(`SELECT * FROM rentals WHERE pass_id = ? ORDER BY date DESC, start DESC, id DESC`),
    activeDup: db.prepare(`SELECT id FROM bookings WHERE slot_id = ? AND student_id = ? AND status = 'active'`),
    insertBooking: db.prepare(`INSERT INTO bookings (slot_id, student_id, note, trial, booked_by, pass_id)
      VALUES (?, ?, ?, ?, ?, ?)`),
    bookingById: db.prepare(`SELECT * FROM bookings WHERE id = ?`),
    cancelBooking: db.prepare(`UPDATE bookings SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ? AND status = 'active'`),
    bookingsByStudent: db.prepare(`
      SELECT b.id, b.status, b.trial, b.note, b.created_at, b.pass_id, p.name AS pass_name, b.attendance,
             s.id AS slot_id, s.title, s.subtitle, s.title_en, s.subtitle_en, s.category, s.start_at, s.duration_min, s.cancelled AS slot_cancelled
      FROM bookings b JOIN slots s ON s.id = b.slot_id LEFT JOIN passes p ON p.id = b.pass_id
      WHERE b.student_id = ? AND s.start_at >= ? ORDER BY s.start_at`),
  };

  const tx = (fn) => (...args) => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(...args); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  const insertTemplate = (t) => Number(q.insertTemplate.run(
    t.title, t.subtitle, t.category, t.weekday, t.time, t.duration, t.capacity, t.note,
    t.titleEn || '', t.subtitleEn || '').lastInsertRowid);
  const insertStudent = (s) => Number(q.insertStudent.run(s.name, s.email, s.phone || '', s.note || '', s.birthday || '',
    s.gender || '', s.healthNotes || '', s.consentPrivacyAt || '', s.consentPhoto || '', s.consentVersion || '',
    s.source || 'admin').lastInsertRowid);

  return {
    // ----- 課程 -----
    listSlots: (from, to) => q.slotsBetween.all(from, to),
    getSlot: (id) => q.slotById.get(id),
    slotBookings: (id) => q.bookingsForSlot.all(id),
    createSlot: (s) => Number(q.insertSlot.run(
      s.title, s.subtitle, s.category, s.startAt, s.duration, s.capacity, s.note,
      s.titleEn || '', s.subtitleEn || '').lastInsertRowid),
    updateSlot: (id, s) => q.updateSlot.run(
      s.title, s.subtitle, s.category, s.startAt, s.duration, s.capacity, s.note,
      s.titleEn || '', s.subtitleEn || '', id).changes > 0,
    setCancelled: (id, v) => q.setCancelled.run(v ? 1 : 0, id).changes > 0,
    deleteSlot: (id) => q.deleteSlot.run(id).changes > 0,

    // ----- 固定課表 -----
    listTemplates: () => q.templates.all(),
    getTemplate: (id) => q.templateById.get(id),
    isEmpty: () => q.countTemplates.get().n === 0 && q.countSlots.get().n === 0,
    createTemplate: insertTemplate,
    createTemplates: tx((items) => items.map(insertTemplate)),
    updateTemplate: tx((id, t, since) => {
      const en = [t.titleEn || '', t.subtitleEn || ''];
      if (!q.updateTemplate.run(t.title, t.subtitle, t.category, t.duration, t.capacity, t.note, ...en, id).changes) return false;
      q.propagateTemplate.run(t.title, t.subtitle, t.category, t.duration, t.note, ...en, t.capacity, id, since);
      return true;
    }),
    /** 刪除固定課表：之後沒人預約的課一併刪掉，已有人預約的保留。回傳保留的堂數。 */
    deleteTemplate: tx((id, since) => {
      if (!q.templateById.get(id)) return null;
      q.deleteFutureEmpty.run(id, since);
      const kept = q.countFutureTpl.get(id, since).n;
      q.deleteTemplate.run(id);
      return kept;
    }),
    /** 依固定課表補齊指定日期的課程（已存在或已停課的不會重複建立）。 */
    generate: tx((dates) => {
      const tpls = q.templates.all();
      let n = 0;
      for (const { date, weekday } of dates) {
        for (const t of tpls) {
          if (t.weekday !== weekday) continue;
          n += q.insertTplSlot.run(t.title, t.subtitle, t.category, `${date}T${t.time}`, t.duration_min,
            t.capacity, t.note, t.id, t.title_en, t.subtitle_en).changes;
        }
      }
      return n;
    }),

    // ----- 學員 -----
    listStudents: (now) => q.students.all(now, now, now),
    getStudent: (id) => q.studentById.get(id),
    /** 同一個信箱的所有學員（家庭帳號）。 */
    studentsByEmail: (email) => q.studentsByEmail.all(email),
    findStudent: (email, name) => q.studentByEmailName.get(email, name),
    createStudent: insertStudent,
    /** 批次建立；同一信箱下已有同名學員的略過（同信箱不同姓名會新增，例如兄弟姊妹）。 */
    createStudents: tx((items) => {
      const created = [], skipped = [];
      for (const s of items) {
        const label = `${s.name} <${s.email}>`;
        if (q.studentByEmailName.get(s.email, s.name)) skipped.push(label);
        else { insertStudent(s); created.push(label); }
      }
      return { created, skipped };
    }),
    updateStudent: (id, s) => q.updateStudent.run(s.name, s.email, s.phone, s.note, s.birthday || '', s.gender || '',
      s.healthNotes || '', id).changes > 0,
    setPhotoConsent: (id, v) => q.setPhotoConsent.run(v, id).changes > 0,
    /** 學員自行註冊（可一次多位，例如兄弟姊妹）。 */
    registerStudents: tx((items) => items.map(insertStudent)),
    // 停用只影響這位學員；同信箱的其他學員照常使用（登入時只會列出啟用中的學員）
    setStudentActive: (id, active) => q.setStudentActive.run(active ? 1 : 0, id).changes > 0,
    /** 只能刪除沒有任何預約紀錄的學員。 */
    deleteStudent: tx((id) => {
      if (!q.studentById.get(id)) return null;
      if (q.countStudentBookings.get(id).n > 0) return false;
      q.deleteStudent.run(id);
      return true;
    }),
    studentBookings: (id, since) => q.bookingsByStudent.all(id, since),

    // ----- 堂數卡 -----
    listPasses: (studentId) => q.passesByStudent.all(studentId),
    getPass: (id) => q.passById.get(id),
    /** 各學員目前的可用堂數與最近到期日（今天起仍有效的卡）。 */
    passSummary: (today) => {
      const out = {};
      const blank = () => ({ remaining: 0, nextExpiry: null, future: 0, unlimited: false, unlimitedUntil: null });
      for (const p of q.allPasses.all(today)) {
        if (!p.unlimited && p.used >= p.total) continue;
        // 上課堂數放在最外層；場地租借時數放在 .rental
        const top = out[p.student_id] ||= { ...blank(), rental: blank() };
        const o = p.kind === 'rental' ? top.rental : top;
        if (p.start_date > today) { if (!p.unlimited) o.future += p.total - p.used; continue; }
        if (p.unlimited) {
          o.unlimited = true;
          if (!o.unlimitedUntil || p.end_date > o.unlimitedUntil) o.unlimitedUntil = p.end_date;
          continue;
        }
        o.remaining += p.total - p.used;
        if (!o.nextExpiry || p.end_date < o.nextExpiry) o.nextExpiry = p.end_date;
      }
      return out;
    },
    createPass: (studentId, p) => Number(q.insertPass.run(
      studentId, p.name, p.total, p.startDate, p.endDate, p.categories, p.note, p.purchaseDate, p.adjust || 0,
      p.unlimited ? 1 : 0, p.kind === 'rental' ? 'rental' : 'class').lastInsertRowid),
    updatePass: (id, p) => q.updatePass.run(p.name, p.total, p.startDate, p.endDate, p.categories, p.note,
      p.purchaseDate, p.adjust || 0, p.unlimited ? 1 : 0, id).changes > 0,
    setPassAdjust: (id, adjust) => q.setPassAdjust.run(adjust, id).changes > 0,
    setPassEnd: (id, end) => q.setPassEnd.run(end, id).changes > 0,
    logPass: (id, action, detail = {}) => q.insertPassLog.run(id, action, JSON.stringify(detail)),
    passLogs: (id) => q.passLogs.all(id).map((l) => ({ action: l.action, detail: JSON.parse(l.detail), at: l.created_at })),
    setPassVoided: (id, v) => q.setPassVoided.run(v ? 1 : 0, id).changes > 0,
    /** 只能刪除從沒被用過的卡；用過的請作廢。 */
    deletePass: (id) => {
      const p = q.passById.get(id);
      if (q.countPassBookings.get(id).n > 0 || (p && p.adjust)) return false;
      return q.deletePass.run(id).changes > 0;
    },
    /** 預覽：這位學員約這堂課會扣哪張卡。 */
    previewPass: (slotId, studentId) => {
      const slot = q.slotById.get(slotId);
      return slot ? pickPass(q.passesByStudent.all(studentId), slot) : null;
    },

    // ----- 密碼 -----
    getAccount: (email) => q.account.get(email),
    setPassword: (email, hash) => q.upsertAccount.run(email, hash),
    /** 產生重設密碼的一次性連結 token。 */
    createReset: (email, ttlMs) => {
      const token = crypto.randomBytes(32).toString('base64url');
      q.purgeResets.run(Date.now());
      q.insertReset.run(hashToken(token), email, Date.now() + ttlMs);
      return token;
    },
    /** 查詢重設 token：有效回傳 email，否則 null。 */
    checkReset: (token) => {
      const r = q.reset.get(hashToken(String(token || '')));
      return r && !r.used && r.expires_at > Date.now() ? r.email : null;
    },
    /** 設定新密碼：作廢這個信箱所有未使用的重設連結，並登出其他裝置。 */
    resetPassword: tx((email, hash) => {
      q.upsertAccount.run(email, hash);
      q.useReset.run(email);
      q.deleteEmailSessions.run(email);
    }),

    // ----- 點名、使用紀錄 -----
    setAttendance: (id, v) => q.setAttendance.run(v, id).changes > 0,
    passUsage: (id) => ({ bookings: q.passUsageBookings.all(id), rentals: q.passUsageRentals.all(id) }),

    // ----- 報表 -----
    reportBookings: (from, to, studentId) => q.reportBookings.all(`${from}T00:00`, `${to}T00:00`, studentId ?? null, studentId ?? null),
    reportRentals: (from, to, studentId) => q.reportRentals.all(from, to, studentId ?? null, studentId ?? null),

    // ----- 場地租借 -----
    rentalsOn: (date) => q.rentalsOn.all(date),
    rentalsBetween: (from, to) => q.rentalsBetween.all(from, to),
    getRental: (id) => q.rentalById.get(id),
    rentalsByStudent: (ids, since) => ids.flatMap((id) => q.rentalsByStudent.all(id, since)),
    slotsOnDay: (date) => q.slotsOnDay.all(`${date}T00:00`, `${date}T99`),
    /**
     * 在交易中檢查空檔並建立租借，避免同時預約超過上限。
     * check(date, start, end) 回傳錯誤訊息或 null。
     */
    /**
     * passMode：'require' 必須有場租卡（學員自己租）、'auto' 有就扣（老師代訂）、'none' 不扣。
     */
    bookRentals: tx((items, check, passMode = 'none') => {
      const ids = [], passes = [];
      for (const r of items) {
        const err = check(r);
        if (err) return { error: err, date: r.date };
        let pass = null;
        if (passMode !== 'none' && r.studentId) pass = pickRentalPass(q.passesByStudent.all(r.studentId), r);
        if (!pass && passMode === 'require') {
          return { error: '沒有足夠的場地租借時數（可能已用完、已過期，或方案不包含這種租借），請聯絡老師購買', code: 'NO_RENTAL_PASS' };
        }
        ids.push(Number(q.insertRental.run(r.studentId ?? null, r.contactName, r.contactPhone || '', r.type, r.date, r.start, r.end,
          r.people, r.price, r.note || '', r.bookedBy || 'student', pass ? pass.id : null, pass ? r.units : 0).lastInsertRowid));
        passes.push(pass ? q.passById.get(pass.id) : null);
      }
      return { ids, passes };
    }),
    /** 預覽：這位學員這筆租借會扣哪張場租卡。 */
    previewRentalPass: (studentId, rental) => pickRentalPass(q.passesByStudent.all(studentId), rental),
    cancelRental: (id) => q.cancelRental.run(id).changes > 0,
    setRentalPaid: (id, v) => q.setRentalPaid.run(v ? 1 : 0, id).changes > 0,

    // ----- 登入 -----
    createSession: (role, studentId, ttlMs) => {
      const token = crypto.randomBytes(32).toString('base64url');
      q.purgeSessions.run(Date.now());
      q.insertSession.run(hashToken(token), role, studentId ?? null, Date.now() + ttlMs);
      if (studentId) q.touchLogin.run(studentId);
      return token;
    },
    getSession: (token) => {
      const s = q.session.get(hashToken(token));
      if (!s) return null;
      if (s.expires_at < Date.now()) { q.deleteSession.run(s.token_hash); return null; }
      return s;
    },
    deleteSession: (token) => q.deleteSession.run(hashToken(token)),

    // ----- 預約 -----
    getBooking: (id) => q.bookingById.get(id),
    cancelBooking: (id) => q.cancelBooking.run(id).changes > 0,

    /** 在交易中檢查名額並建立預約，避免超賣。回傳 {error} 或 {booking, slot}。 */
    // usePass：'auto' 自動扣最快到期的卡、'none' 不扣堂；requirePass：沒有可用堂數時拒絕預約
    book: tx(({ slotId, studentId, note, trial, bookedBy, isOpen, usePass = 'none', requirePass = false }) => {
      const slot = q.slotById.get(slotId);
      if (!slot) return { error: '找不到這堂課', status: 404 };
      if (slot.cancelled) return { error: '這堂課已停課', status: 409 };
      if (!isOpen(slot)) return { error: '這堂課已經開始或已截止預約', status: 409 };
      if (slot.booked >= slot.capacity) return { error: '這堂課已額滿', status: 409 };
      if (q.activeDup.get(slotId, studentId)) return { error: '已經預約過這堂課了', status: 409 };
      const pass = usePass === 'auto' ? pickPass(q.passesByStudent.all(studentId), slot) : null;
      if (!pass && requirePass) {
        return { error: '沒有可用的堂數（可能已用完或已過期），請聯絡老師購買或續約', status: 409 };
      }
      const id = Number(q.insertBooking.run(slotId, studentId, note || '', trial ? 1 : 0, bookedBy || 'student',
        pass ? pass.id : null).lastInsertRowid);
      return {
        booking: q.bookingById.get(id), slot: q.slotById.get(slotId),
        pass: pass ? q.passById.get(pass.id) : null,
      };
    }),
  };
}

module.exports = { openDb, createStore, passStatus };
