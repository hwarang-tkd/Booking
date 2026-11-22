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
    CREATE TABLE IF NOT EXISTS slots (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      title        TEXT    NOT NULL,
      start_at     TEXT    NOT NULL,            -- 當地時間 'YYYY-MM-DDTHH:MM'
      duration_min INTEGER NOT NULL,
      capacity     INTEGER NOT NULL,
      note         TEXT    NOT NULL DEFAULT '',
      created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_slots_start ON slots(start_at);
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

function createStore(db) {
  const q = {
    slotsBetween: db.prepare(`
      SELECT s.*, (SELECT COUNT(*) FROM bookings b WHERE b.slot_id = s.id AND b.status = 'active') AS booked
      FROM slots s WHERE s.start_at >= ? AND s.start_at < ? ORDER BY s.start_at, s.id`),
    slotById: db.prepare(`
      SELECT s.*, (SELECT COUNT(*) FROM bookings b WHERE b.slot_id = s.id AND b.status = 'active') AS booked
      FROM slots s WHERE s.id = ?`),
    insertSlot: db.prepare(`INSERT INTO slots (title, start_at, duration_min, capacity, note) VALUES (?, ?, ?, ?, ?)`),
    updateSlot: db.prepare(`UPDATE slots SET title = ?, start_at = ?, duration_min = ?, capacity = ?, note = ? WHERE id = ?`),
    deleteSlot: db.prepare(`DELETE FROM slots WHERE id = ?`),
    bookingsForSlot: db.prepare(`SELECT * FROM bookings WHERE slot_id = ? ORDER BY status, created_at`),
    activeDup: db.prepare(`SELECT id FROM bookings WHERE slot_id = ? AND phone = ? AND status = 'active'`),
    insertBooking: db.prepare(`INSERT INTO bookings (slot_id, name, phone, note, code) VALUES (?, ?, ?, ?, ?)`),
    bookingById: db.prepare(`SELECT * FROM bookings WHERE id = ?`),
    bookingByCode: db.prepare(`SELECT * FROM bookings WHERE code = ?`),
    codeExists: db.prepare(`SELECT 1 FROM bookings WHERE code = ?`),
    cancelBooking: db.prepare(`UPDATE bookings SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ? AND status = 'active'`),
    bookingsByPhone: db.prepare(`
      SELECT b.id, b.code, b.name, b.status, b.created_at, s.id AS slot_id, s.title, s.start_at, s.duration_min, s.note AS slot_note
      FROM bookings b JOIN slots s ON s.id = b.slot_id
      WHERE b.phone = ? AND s.start_at >= ? ORDER BY s.start_at`),
  };

  const tx = (fn) => (...args) => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(...args); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  return {
    listSlots: (from, to) => q.slotsBetween.all(from, to),
    getSlot: (id) => q.slotById.get(id),
    slotBookings: (id) => q.bookingsForSlot.all(id),
    createSlot: ({ title, startAt, duration, capacity, note }) =>
      Number(q.insertSlot.run(title, startAt, duration, capacity, note).lastInsertRowid),
    createSlots: tx((items) => items.map((s) =>
      Number(q.insertSlot.run(s.title, s.startAt, s.duration, s.capacity, s.note).lastInsertRowid))),
    updateSlot: (id, { title, startAt, duration, capacity, note }) =>
      q.updateSlot.run(title, startAt, duration, capacity, note, id).changes > 0,
    deleteSlot: (id) => q.deleteSlot.run(id).changes > 0,
    getBooking: (id) => q.bookingById.get(id),
    getBookingByCode: (code) => q.bookingByCode.get(code),
    cancelBooking: (id) => q.cancelBooking.run(id).changes > 0,
    bookingsByPhone: (phone, since) => q.bookingsByPhone.all(phone, since),

    /** 在交易中檢查名額並建立預約，避免超賣。回傳 {error} 或 {booking}。 */
    book: tx(({ slotId, name, phone, note, isOpen }) => {
      const slot = q.slotById.get(slotId);
      if (!slot) return { error: '找不到這堂課', status: 404 };
      if (!isOpen(slot)) return { error: '這堂課已經開始或已截止預約', status: 409 };
      if (slot.booked >= slot.capacity) return { error: '這堂課已額滿', status: 409 };
      if (q.activeDup.get(slotId, phone)) return { error: '這支電話已經預約過這堂課', status: 409 };
      let code;
      do { code = newCode(); } while (q.codeExists.get(code));
      const id = Number(q.insertBooking.run(slotId, name, phone, note, code).lastInsertRowid);
      return { booking: q.bookingById.get(id), slot: q.slotById.get(slotId) };
    }),
  };
}

module.exports = { openDb, createStore };
