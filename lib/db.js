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
  allowSharedEmails(db, cols);
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

// 已使用堂數：有效預約、且那堂課沒有停課（取消或停課會自動退回堂數）
const USED = `(SELECT COUNT(*) FROM bookings b JOIN slots s ON s.id = b.slot_id
  WHERE b.pass_id = p.id AND b.status = 'active' AND s.cancelled = 0)`;

/** 堂數卡狀態：void 作廢、future 未開始、expired 已過期、used 已用完、active 使用中 */
function passStatus(p, today) {
  if (p.voided) return 'void';
  if (today < p.start_date) return 'future';
  if (today > p.end_date) return 'expired';
  if (p.used >= p.total) return 'used';
  return 'active';
}

/** 某堂課可以用哪張卡：未作廢、在有效期限內（以上課日期判斷）、還有剩、適用這類課程；優先用最快到期的。 */
function pickPass(passes, slot) {
  const date = slot.start_at.slice(0, 10);
  return passes
    .filter((p) => !p.voided && p.start_date <= date && date <= p.end_date && p.used < p.total
      && (!p.categories || p.categories.split(',').includes(slot.category)))
    .sort((a, b) => a.end_date.localeCompare(b.end_date) || a.id - b.id)[0] || null;
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
    insertStudent: db.prepare(`INSERT INTO students (name, email, phone, note, birthday) VALUES (?, ?, ?, ?, ?)`),
    updateStudent: db.prepare(`UPDATE students SET name = ?, email = ?, phone = ?, note = ?, birthday = ? WHERE id = ?`),
    setStudentActive: db.prepare(`UPDATE students SET active = ? WHERE id = ?`),
    deleteStudent: db.prepare(`DELETE FROM students WHERE id = ?`),
    countStudentBookings: db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE student_id = ?`),
    touchLogin: db.prepare(`UPDATE students SET last_login = datetime('now')
      WHERE email = (SELECT email FROM students WHERE id = ?)`),

    // 堂數卡
    passesByStudent: db.prepare(`SELECT p.*, ${USED} AS used FROM passes p WHERE p.student_id = ?
      ORDER BY p.voided, p.end_date DESC, p.id DESC`),
    allPasses: db.prepare(`SELECT p.*, ${USED} AS used FROM passes p WHERE p.voided = 0 AND p.end_date >= ?`),
    passById: db.prepare(`SELECT p.*, ${USED} AS used FROM passes p WHERE p.id = ?`),
    insertPass: db.prepare(`INSERT INTO passes (student_id, name, total, start_date, end_date, categories, note, purchase_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    updatePass: db.prepare(`UPDATE passes SET name = ?, total = ?, start_date = ?, end_date = ?, categories = ?, note = ?,
      purchase_date = ? WHERE id = ?`),
    setPassVoided: db.prepare(`UPDATE passes SET voided = ? WHERE id = ?`),
    countPassBookings: db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE pass_id = ?`),
    deletePass: db.prepare(`DELETE FROM passes WHERE id = ?`),

    // 登入
    insertSession: db.prepare(`INSERT INTO sessions (token_hash, role, student_id, expires_at) VALUES (?, ?, ?, ?)`),
    session: db.prepare(`SELECT * FROM sessions WHERE token_hash = ?`),
    deleteSession: db.prepare(`DELETE FROM sessions WHERE token_hash = ?`),
    purgeSessions: db.prepare(`DELETE FROM sessions WHERE expires_at < ?`),

    // 預約
    bookingsForSlot: db.prepare(`
      SELECT b.*, st.name, st.email, st.phone, st.birthday, p.name AS pass_name FROM bookings b
      JOIN students st ON st.id = b.student_id LEFT JOIN passes p ON p.id = b.pass_id
      WHERE b.slot_id = ? ORDER BY b.status, b.created_at`),
    activeDup: db.prepare(`SELECT id FROM bookings WHERE slot_id = ? AND student_id = ? AND status = 'active'`),
    insertBooking: db.prepare(`INSERT INTO bookings (slot_id, student_id, note, trial, booked_by, pass_id)
      VALUES (?, ?, ?, ?, ?, ?)`),
    bookingById: db.prepare(`SELECT * FROM bookings WHERE id = ?`),
    cancelBooking: db.prepare(`UPDATE bookings SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ? AND status = 'active'`),
    bookingsByStudent: db.prepare(`
      SELECT b.id, b.status, b.trial, b.note, b.created_at, b.pass_id, p.name AS pass_name,
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
  const insertStudent = (s) => Number(q.insertStudent.run(s.name, s.email, s.phone, s.note, s.birthday || '').lastInsertRowid);

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
    updateStudent: (id, s) => q.updateStudent.run(s.name, s.email, s.phone, s.note, s.birthday || '', id).changes > 0,
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
      for (const p of q.allPasses.all(today)) {
        if (p.used >= p.total) continue;
        const o = out[p.student_id] ||= { remaining: 0, nextExpiry: null, future: 0 };
        if (p.start_date > today) { o.future += p.total - p.used; continue; }
        o.remaining += p.total - p.used;
        if (!o.nextExpiry || p.end_date < o.nextExpiry) o.nextExpiry = p.end_date;
      }
      return out;
    },
    createPass: (studentId, p) => Number(q.insertPass.run(
      studentId, p.name, p.total, p.startDate, p.endDate, p.categories, p.note, p.purchaseDate).lastInsertRowid),
    updatePass: (id, p) => q.updatePass.run(p.name, p.total, p.startDate, p.endDate, p.categories, p.note,
      p.purchaseDate, id).changes > 0,
    setPassVoided: (id, v) => q.setPassVoided.run(v ? 1 : 0, id).changes > 0,
    /** 只能刪除從沒被用過的卡；用過的請作廢。 */
    deletePass: (id) => {
      if (q.countPassBookings.get(id).n > 0) return false;
      return q.deletePass.run(id).changes > 0;
    },
    /** 預覽：這位學員約這堂課會扣哪張卡。 */
    previewPass: (slotId, studentId) => {
      const slot = q.slotById.get(slotId);
      return slot ? pickPass(q.passesByStudent.all(studentId), slot) : null;
    },

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
