'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
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
    CREATE TABLE IF NOT EXISTS bookings (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      slot_id      INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
      name         TEXT    NOT NULL,
      phone        TEXT    NOT NULL,
      note         TEXT    NOT NULL DEFAULT '',
      code         TEXT    NOT NULL UNIQUE,
      status       TEXT    NOT NULL DEFAULT 'active',  -- active | cancelled
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      cancelled_at TEXT
    );
  `);
  // 舊版資料庫補欄位
  const addCol = (table, col, def) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  };
  addCol('slots', 'subtitle', "TEXT NOT NULL DEFAULT ''");
  addCol('slots', 'category', "TEXT NOT NULL DEFAULT 'other'");
  addCol('slots', 'template_id', 'INTEGER REFERENCES templates(id) ON DELETE SET NULL');
  addCol('slots', 'cancelled', 'INTEGER NOT NULL DEFAULT 0');   // 1 = 停課
  addCol('bookings', 'trial', 'INTEGER NOT NULL DEFAULT 0');    // 1 = 體驗課
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_slots_start ON slots(start_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_slots_tpl ON slots(template_id, start_at) WHERE template_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_bookings_slot  ON bookings(slot_id);
    CREATE INDEX IF NOT EXISTS idx_bookings_phone ON bookings(phone);
  `);
  return db;
}

function newCode() {
  const bytes = crypto.randomBytes(6);
  let s = '';
  for (const b of bytes) s += CODE_CHARS[b % CODE_CHARS.length];
  return s;
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
    // 套用到之後已產生的課程；名額不會低於已預約人數
    propagateTemplate: db.prepare(`UPDATE slots SET title = ?, subtitle = ?, category = ?, duration_min = ?, note = ?,
      capacity = MAX(?, (SELECT COUNT(*) FROM bookings b WHERE b.slot_id = slots.id AND b.status = 'active'))
      WHERE template_id = ? AND start_at >= ?`),
    deleteFutureEmpty: db.prepare(`DELETE FROM slots WHERE template_id = ? AND start_at >= ?
      AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id = slots.id AND b.status = 'active')`),
    deleteTemplate: db.prepare(`DELETE FROM templates WHERE id = ?`),

    bookingsForSlot: db.prepare(`SELECT * FROM bookings WHERE slot_id = ? ORDER BY status, created_at`),
    activeDup: db.prepare(`SELECT id FROM bookings WHERE slot_id = ? AND phone = ? AND status = 'active'`),
    insertBooking: db.prepare(`INSERT INTO bookings (slot_id, name, phone, note, code, trial) VALUES (?, ?, ?, ?, ?, ?)`),
    bookingById: db.prepare(`SELECT * FROM bookings WHERE id = ?`),
    bookingByCode: db.prepare(`SELECT * FROM bookings WHERE code = ?`),
    codeExists: db.prepare(`SELECT 1 FROM bookings WHERE code = ?`),
    cancelBooking: db.prepare(`UPDATE bookings SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ? AND status = 'active'`),
    bookingsByPhone: db.prepare(`
      SELECT b.id, b.code, b.name, b.status, b.trial, b.created_at, s.id AS slot_id, s.title, s.subtitle, s.category,
             s.start_at, s.duration_min, s.cancelled AS slot_cancelled
      FROM bookings b JOIN slots s ON s.id = b.slot_id
      WHERE b.phone = ? AND s.start_at >= ? ORDER BY s.start_at`),
  };

  const tx = (fn) => (...args) => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(...args); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  const insertTemplate = (t) => Number(q.insertTemplate.run(
    t.title, t.subtitle, t.category, t.weekday, t.time, t.duration, t.capacity, t.note).lastInsertRowid);

  return {
    listSlots: (from, to) => q.slotsBetween.all(from, to),
    getSlot: (id) => q.slotById.get(id),
    slotBookings: (id) => q.bookingsForSlot.all(id),
    createSlot: (s) => Number(q.insertSlot.run(
      s.title, s.subtitle, s.category, s.startAt, s.duration, s.capacity, s.note).lastInsertRowid),
    updateSlot: (id, s) => q.updateSlot.run(
      s.title, s.subtitle, s.category, s.startAt, s.duration, s.capacity, s.note, id).changes > 0,
    setCancelled: (id, v) => q.setCancelled.run(v ? 1 : 0, id).changes > 0,
    deleteSlot: (id) => q.deleteSlot.run(id).changes > 0,

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
      const kept = db.prepare(`SELECT COUNT(*) AS n FROM slots WHERE template_id = ? AND start_at >= ?`).get(id, since).n;
      q.deleteTemplate.run(id);
      return kept;
    }),
    /** 依固定課表補齊 [fromDate, toDate) 期間的課程（已存在或已停課的不會重複建立）。 */
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

    getBooking: (id) => q.bookingById.get(id),
    getBookingByCode: (code) => q.bookingByCode.get(code),
    cancelBooking: (id) => q.cancelBooking.run(id).changes > 0,
    bookingsByPhone: (phone, since) => q.bookingsByPhone.all(phone, since),

    /** 在交易中檢查名額並建立預約，避免超賣。回傳 {error} 或 {booking}。 */
    book: tx(({ slotId, name, phone, note, trial, isOpen }) => {
      const slot = q.slotById.get(slotId);
      if (!slot) return { error: '找不到這堂課', status: 404 };
      if (slot.cancelled) return { error: '這堂課已停課', status: 409 };
      if (!isOpen(slot)) return { error: '這堂課已經開始或已截止預約', status: 409 };
      if (slot.booked >= slot.capacity) return { error: '這堂課已額滿', status: 409 };
      if (q.activeDup.get(slotId, phone)) return { error: '這支電話已經預約過這堂課', status: 409 };
      let code;
      do { code = newCode(); } while (q.codeExists.get(code));
      const id = Number(q.insertBooking.run(slotId, name, phone, note, code, trial ? 1 : 0).lastInsertRowid);
      return { booking: q.bookingById.get(id), slot: q.slotById.get(slotId) };
    }),
  };
}

module.exports = { openDb, createStore };
