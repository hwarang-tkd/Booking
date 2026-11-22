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
      email        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
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
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_slots_start ON slots(start_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_slots_tpl ON slots(template_id, start_at) WHERE template_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_bookings_slot    ON bookings(slot_id);
    CREATE INDEX IF NOT EXISTS idx_bookings_student ON bookings(student_id);
  `);
  return db;
}

const BOOKED = `(SELECT COUNT(*) FROM bookings b WHERE b.slot_id = s.id AND b.status = 'active')`;

function createStore(db) {
  const q = {
    slotsBetween: db.prepare(`SELECT s.*, ${BOOKED} AS booked FROM slots s
      WHERE s.start_at >= ? AND s.start_at < ? ORDER BY s.start_at, s.id`),
    slotById: db.prepare(`SELECT s.*, ${BOOKED} AS booked FROM slots s WHERE s.id = ?`),
    insertSlot: db.prepare(`INSERT INTO slots (title, subtitle, category, start_at, duration_min, capacity, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    insertTplSlot: db.prepare(`INSERT OR IGNORE INTO slots
      (title, subtitle, category, start_at, duration_min, capacity, note, template_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    updateSlot: db.prepare(`UPDATE slots SET title = ?, subtitle = ?, category = ?, start_at = ?, duration_min = ?,
      capacity = ?, note = ? WHERE id = ?`),
    setCancelled: db.prepare(`UPDATE slots SET cancelled = ? WHERE id = ?`),
    deleteSlot: db.prepare(`DELETE FROM slots WHERE id = ?`),

    templates: db.prepare(`SELECT * FROM templates ORDER BY (weekday + 6) % 7, time, id`),
    templateById: db.prepare(`SELECT * FROM templates WHERE id = ?`),
    countTemplates: db.prepare(`SELECT COUNT(*) AS n FROM templates`),
    countSlots: db.prepare(`SELECT COUNT(*) AS n FROM slots`),
    insertTemplate: db.prepare(`INSERT INTO templates (title, subtitle, category, weekday, time, duration_min, capacity, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    updateTemplate: db.prepare(`UPDATE templates SET title = ?, subtitle = ?, category = ?, duration_min = ?,
      capacity = ?, note = ? WHERE id = ?`),
    propagateTemplate: db.prepare(`UPDATE slots SET title = ?, subtitle = ?, category = ?, duration_min = ?, note = ?,
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
    studentByEmail: db.prepare(`SELECT * FROM students WHERE email = ?`),
    insertStudent: db.prepare(`INSERT INTO students (name, email, phone, note) VALUES (?, ?, ?, ?)`),
    updateStudent: db.prepare(`UPDATE students SET name = ?, email = ?, phone = ?, note = ? WHERE id = ?`),
    setStudentActive: db.prepare(`UPDATE students SET active = ? WHERE id = ?`),
    deleteStudent: db.prepare(`DELETE FROM students WHERE id = ?`),
    countStudentBookings: db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE student_id = ?`),
    touchLogin: db.prepare(`UPDATE students SET last_login = datetime('now') WHERE id = ?`),

    // 登入
    insertSession: db.prepare(`INSERT INTO sessions (token_hash, role, student_id, expires_at) VALUES (?, ?, ?, ?)`),
    session: db.prepare(`SELECT * FROM sessions WHERE token_hash = ?`),
    deleteSession: db.prepare(`DELETE FROM sessions WHERE token_hash = ?`),
    deleteStudentSessions: db.prepare(`DELETE FROM sessions WHERE student_id = ?`),
    purgeSessions: db.prepare(`DELETE FROM sessions WHERE expires_at < ?`),

    // 預約
    bookingsForSlot: db.prepare(`
      SELECT b.*, st.name, st.email, st.phone FROM bookings b JOIN students st ON st.id = b.student_id
      WHERE b.slot_id = ? ORDER BY b.status, b.created_at`),
    activeDup: db.prepare(`SELECT id FROM bookings WHERE slot_id = ? AND student_id = ? AND status = 'active'`),
    insertBooking: db.prepare(`INSERT INTO bookings (slot_id, student_id, note, trial, booked_by) VALUES (?, ?, ?, ?, ?)`),
    bookingById: db.prepare(`SELECT * FROM bookings WHERE id = ?`),
    cancelBooking: db.prepare(`UPDATE bookings SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ? AND status = 'active'`),
    bookingsByStudent: db.prepare(`
      SELECT b.id, b.status, b.trial, b.note, b.created_at, s.id AS slot_id, s.title, s.subtitle, s.category,
             s.start_at, s.duration_min, s.cancelled AS slot_cancelled
      FROM bookings b JOIN slots s ON s.id = b.slot_id
      WHERE b.student_id = ? AND s.start_at >= ? ORDER BY s.start_at`),
  };

  const tx = (fn) => (...args) => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(...args); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  const insertTemplate = (t) => Number(q.insertTemplate.run(
    t.title, t.subtitle, t.category, t.weekday, t.time, t.duration, t.capacity, t.note).lastInsertRowid);
  const insertStudent = (s) => Number(q.insertStudent.run(s.name, s.email, s.phone, s.note).lastInsertRowid);

  return {
    // ----- 課程 -----
    listSlots: (from, to) => q.slotsBetween.all(from, to),
    getSlot: (id) => q.slotById.get(id),
    slotBookings: (id) => q.bookingsForSlot.all(id),
    createSlot: (s) => Number(q.insertSlot.run(
      s.title, s.subtitle, s.category, s.startAt, s.duration, s.capacity, s.note).lastInsertRowid),
    updateSlot: (id, s) => q.updateSlot.run(
      s.title, s.subtitle, s.category, s.startAt, s.duration, s.capacity, s.note, id).changes > 0,
    setCancelled: (id, v) => q.setCancelled.run(v ? 1 : 0, id).changes > 0,
    deleteSlot: (id) => q.deleteSlot.run(id).changes > 0,

    // ----- 固定課表 -----
    listTemplates: () => q.templates.all(),
    getTemplate: (id) => q.templateById.get(id),
    isEmpty: () => q.countTemplates.get().n === 0 && q.countSlots.get().n === 0,
    createTemplate: insertTemplate,
    createTemplates: tx((items) => items.map(insertTemplate)),
    updateTemplate: tx((id, t, since) => {
      if (!q.updateTemplate.run(t.title, t.subtitle, t.category, t.duration, t.capacity, t.note, id).changes) return false;
      q.propagateTemplate.run(t.title, t.subtitle, t.category, t.duration, t.note, t.capacity, id, since);
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
            t.capacity, t.note, t.id).changes;
        }
      }
      return n;
    }),

    // ----- 學員 -----
    listStudents: (now) => q.students.all(now, now, now),
    getStudent: (id) => q.studentById.get(id),
    getStudentByEmail: (email) => q.studentByEmail.get(email),
    createStudent: insertStudent,
    /** 批次建立；信箱已存在的略過。 */
    createStudents: tx((items) => {
      const created = [], skipped = [];
      for (const s of items) {
        if (q.studentByEmail.get(s.email)) skipped.push(s.email);
        else { insertStudent(s); created.push(s.email); }
      }
      return { created, skipped };
    }),
    updateStudent: (id, s) => q.updateStudent.run(s.name, s.email, s.phone, s.note, id).changes > 0,
    setStudentActive: tx((id, active) => {
      const ok = q.setStudentActive.run(active ? 1 : 0, id).changes > 0;
      if (ok && !active) q.deleteStudentSessions.run(id);
      return ok;
    }),
    /** 只能刪除沒有任何預約紀錄的學員。 */
    deleteStudent: tx((id) => {
      if (!q.studentById.get(id)) return null;
      if (q.countStudentBookings.get(id).n > 0) return false;
      q.deleteStudent.run(id);
      return true;
    }),
    studentBookings: (id, since) => q.bookingsByStudent.all(id, since),

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
    book: tx(({ slotId, studentId, note, trial, bookedBy, isOpen }) => {
      const slot = q.slotById.get(slotId);
      if (!slot) return { error: '找不到這堂課', status: 404 };
      if (slot.cancelled) return { error: '這堂課已停課', status: 409 };
      if (!isOpen(slot)) return { error: '這堂課已經開始或已截止預約', status: 409 };
      if (slot.booked >= slot.capacity) return { error: '這堂課已額滿', status: 409 };
      if (q.activeDup.get(slotId, studentId)) return { error: '已經預約過這堂課了', status: 409 };
      const id = Number(q.insertBooking.run(slotId, studentId, note || '', trial ? 1 : 0, bookedBy || 'student').lastInsertRowid);
      return { booking: q.bookingById.get(id), slot: q.slotById.get(slotId) };
    }),
  };
}

module.exports = { openDb, createStore };
