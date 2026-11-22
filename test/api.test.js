'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp, loadConfig } = require('../server');
const T = require('../lib/time');

const TZ = 'Asia/Taipei';
let server, base, token;
const today = () => T.nowLocal(TZ).slice(0, 10);

async function req(path, { method = 'GET', body, auth } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (auth) headers.Authorization = 'Bearer ' + auth;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}

before(async () => {
  const cfg = { ...loadConfig({}), dbPath: ':memory:', adminPassword: 'secret', timeZone: TZ, cancelHours: 2 };
  server = createApp(cfg);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('後台需要登入', async () => {
  assert.equal((await req('/api/admin/slots')).status, 401);
  assert.equal((await req('/api/admin/login', { method: 'POST', body: { password: 'nope' } })).status, 401);
  const r = await req('/api/admin/login', { method: 'POST', body: { password: 'secret' } });
  assert.equal(r.status, 200);
  token = r.data.token;
});

test('批次開課：依星期產生課程', async () => {
  const start = T.addDays(today(), 1);
  const end = T.addDays(start, 13); // 兩週
  const r = await req('/api/admin/slots/batch', { method: 'POST', auth: token, body: {
    title: '兒童班', startDate: start, endDate: end, weekdays: [1, 3], times: ['18:00', '19:30'],
    duration: 60, capacity: 2, note: '',
  } });
  assert.equal(r.status, 201);
  assert.equal(r.data.created, 8); // 2 週 × 2 天 × 2 時段
});

test('學生預約：名額、重複、額滿', async () => {
  const { data } = await req('/api/slots?days=20');
  assert.ok(data.slots.length >= 8);
  const slot = data.slots[0];
  assert.equal(slot.remaining, 2);

  const a = await req('/api/bookings', { method: 'POST', body: { slotId: slot.id, name: '小明', phone: '0912-345-678' } });
  assert.equal(a.status, 201);
  assert.match(a.data.code, /^[A-Z2-9]{6}$/);

  const dup = await req('/api/bookings', { method: 'POST', body: { slotId: slot.id, name: '小明', phone: '0912345678' } });
  assert.equal(dup.status, 409);

  const b = await req('/api/bookings', { method: 'POST', body: { slotId: slot.id, name: '小華', phone: '0922000111' } });
  assert.equal(b.status, 201);

  const c = await req('/api/bookings', { method: 'POST', body: { slotId: slot.id, name: '小美', phone: '0933000111' } });
  assert.equal(c.status, 409);
  assert.equal(c.data.error, '這堂課已額滿');

  const bad = await req('/api/bookings', { method: 'POST', body: { slotId: slot.id, name: '', phone: '123' } });
  assert.equal(bad.status, 400);

  // 查詢與取消
  const mine = await req('/api/bookings?phone=0912345678');
  assert.equal(mine.data.bookings.length, 1);
  assert.equal(mine.data.bookings[0].cancellable, true);
  assert.equal(mine.data.bookings[0].codeHint.slice(0, 2), a.data.code.slice(0, 2));

  const wrong = await req('/api/bookings/cancel', { method: 'POST', body: { phone: '0922000111', code: a.data.code } });
  assert.equal(wrong.status, 404);
  const ok = await req('/api/bookings/cancel', { method: 'POST', body: { phone: '0912345678', code: a.data.code.toLowerCase() } });
  assert.equal(ok.status, 200);
  const again = await req('/api/bookings/cancel', { method: 'POST', body: { phone: '0912345678', code: a.data.code } });
  assert.equal(again.status, 409);

  const after = (await req('/api/slots?days=20')).data.slots.find((s) => s.id === slot.id);
  assert.equal(after.remaining, 1);
});

test('上課前 2 小時內無法線上取消，過去的課不能預約', async () => {
  const soon = T.fromMs(T.toMs(T.nowLocal(TZ)) + 60 * 60000); // 1 小時後
  const r = await req('/api/admin/slots', { method: 'POST', auth: token, body: {
    title: '急課', date: soon.slice(0, 10), time: soon.slice(11), duration: 60, capacity: 5,
  } });
  assert.equal(r.status, 201);
  const bk = await req('/api/bookings', { method: 'POST', body: { slotId: r.data.id, name: '阿強', phone: '0955111222' } });
  assert.equal(bk.status, 201);
  const cancel = await req('/api/bookings/cancel', { method: 'POST', body: { phone: '0955111222', code: bk.data.code } });
  assert.equal(cancel.status, 409);

  const past = T.fromMs(T.toMs(T.nowLocal(TZ)) - 60 * 60000);
  const p = await req('/api/admin/slots', { method: 'POST', auth: token, body: {
    title: '舊課', date: past.slice(0, 10), time: past.slice(11), duration: 60, capacity: 5,
  } });
  const bp = await req('/api/bookings', { method: 'POST', body: { slotId: p.data.id, name: '阿強', phone: '0955111222' } });
  assert.equal(bp.status, 409);
});

test('後台：名單、修改名額、代約、刪課', async () => {
  const from = today(), to = T.addDays(from, 20);
  const { data } = await req(`/api/admin/slots?from=${from}&to=${to}`, { auth: token });
  const s = data.slots.find((x) => x.booked === 1 && x.title === '兒童班');
  assert.ok(s);
  assert.equal(s.bookings.length, 2); // 一筆有效、一筆已取消

  const shrink = await req(`/api/admin/slots/${s.id}`, { method: 'PUT', auth: token, body: {
    title: s.title, date: s.startAt.slice(0, 10), time: s.startAt.slice(11), duration: 60, capacity: 0,
  } });
  assert.equal(shrink.status, 400);

  const add = await req(`/api/admin/slots/${s.id}/bookings`, { method: 'POST', auth: token, body: { name: '小美', phone: '0933000111' } });
  assert.equal(add.status, 201);

  const active = s.bookings.find((b) => b.status === 'active');
  assert.equal((await req(`/api/admin/bookings/${active.id}/cancel`, { method: 'POST', auth: token })).status, 200);

  assert.equal((await req(`/api/admin/slots/${s.id}`, { method: 'DELETE', auth: token })).status, 200);
  assert.equal((await req(`/api/admin/slots/${s.id}`, { method: 'DELETE', auth: token })).status, 404);
});

test('靜態頁面與路徑安全', async () => {
  for (const p of ['/', '/my', '/admin', '/style.css']) {
    assert.equal((await fetch(base + p)).status, 200, p);
  }
  assert.notEqual((await fetch(base + '/..%2fserver.js')).status, 200);
});

test('時間工具', () => {
  assert.equal(T.isValidDate('2026-02-30'), false);
  assert.equal(T.isValidDate('2026-02-28'), true);
  assert.equal(T.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(T.weekday('2026-11-22'), 0);
});
