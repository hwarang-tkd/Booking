'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createApp, loadConfig } = require('../server');
const { DEFAULT_TEMPLATES } = require('../lib/schedule');
const T = require('../lib/time');

const TZ = 'Asia/Taipei';
const today = () => T.nowLocal(TZ).slice(0, 10);

async function start(overrides = {}) {
  const cfg = { ...loadConfig({}), dbPath: ':memory:', adminPassword: 'secret', timeZone: TZ, cancelHours: 2, ...overrides };
  const server = createApp(cfg);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (path, { method = 'GET', body, auth } = {}) => {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (auth) headers.Authorization = 'Bearer ' + auth;
    const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  return { server, base, req };
}

describe('預設課表', () => {
  let app;
  before(async () => { app = await start(); });
  after(() => app.server.close());

  test('全新資料庫會載入花郎武道館課表，並自動開放 4 週課程', async () => {
    const { data } = await app.req('/api/templates');
    assert.equal(data.templates.length, DEFAULT_TEMPLATES.length);
    const s = await app.req('/api/slots?days=29');
    // 28 天 = 剛好 4 週，加上今天可能多一天；每週 16 堂
    assert.ok(s.data.slots.length >= 4 * 16 - 16 && s.data.slots.length <= 5 * 16, String(s.data.slots.length));
    const cats = new Set(s.data.slots.map((x) => x.category));
    for (const c of ['tkd', 'kids', 'little', 'combat', 'blackbelt', 'private']) assert.ok(cats.has(c), c);
    // 重複查詢不會重複產生
    const again = await app.req('/api/slots?days=29');
    assert.equal(again.data.slots.length, s.data.slots.length);
  });
});

describe('API', () => {
  let req, server, token;
  before(async () => { ({ req, server } = await start({ seedSchedule: false })); });
  after(() => server.close());

  test('後台需要登入', async () => {
    assert.equal((await req('/api/admin/slots')).status, 401);
    assert.equal((await req('/api/admin/login', { method: 'POST', body: { password: 'nope' } })).status, 401);
    const r = await req('/api/admin/login', { method: 'POST', body: { password: 'secret' } });
    assert.equal(r.status, 200);
    token = r.data.token;
  });

  test('固定課表：新增後自動產生每週課程，修改會套用到之後的課', async () => {
    const tomorrow = T.addDays(today(), 1);
    const r = await req('/api/admin/templates', { method: 'POST', auth: token, body: {
      title: '兒童班', subtitle: 'Kids', category: 'kids', weekday: T.weekday(tomorrow), time: '18:00',
      duration: 60, capacity: 2,
    } });
    assert.equal(r.status, 201);
    const { data } = await req('/api/slots?days=29');
    const mine = data.slots.filter((s) => s.title === '兒童班');
    assert.ok(mine.length >= 4);
    assert.equal(mine[0].startAt, `${tomorrow}T18:00`);
    assert.equal(mine[0].category, 'kids');

    const upd = await req(`/api/admin/templates/${r.data.id}`, { method: 'PUT', auth: token, body: {
      title: '兒童班', subtitle: 'Kids 8-12', category: 'kids', duration: 60, capacity: 2,
    } });
    assert.equal(upd.status, 200);
    const after2 = (await req('/api/slots?days=29')).data.slots.filter((s) => s.title === '兒童班');
    assert.ok(after2.every((s) => s.subtitle === 'Kids 8-12'));
  });

  test('學生預約：名額、重複、額滿、體驗課、取消', async () => {
    const slot = (await req('/api/slots?days=20')).data.slots.find((s) => s.title === '兒童班');
    assert.equal(slot.remaining, 2);

    const a = await req('/api/bookings', { method: 'POST', body: { slotId: slot.id, name: '小明', phone: '0912-345-678', trial: true } });
    assert.equal(a.status, 201);
    assert.match(a.data.code, /^[A-Z2-9]{6}$/);
    assert.equal(a.data.trial, true);

    const dup = await req('/api/bookings', { method: 'POST', body: { slotId: slot.id, name: '小明', phone: '0912345678' } });
    assert.equal(dup.status, 409);
    const b = await req('/api/bookings', { method: 'POST', body: { slotId: slot.id, name: '小華', phone: '0922000111' } });
    assert.equal(b.status, 201);
    const c = await req('/api/bookings', { method: 'POST', body: { slotId: slot.id, name: '小美', phone: '0933000111' } });
    assert.equal(c.status, 409);
    assert.equal(c.data.error, '這堂課已額滿');
    assert.equal((await req('/api/bookings', { method: 'POST', body: { slotId: slot.id, name: '', phone: '123' } })).status, 400);

    const mine = await req('/api/bookings?phone=0912345678');
    assert.equal(mine.data.bookings.length, 1);
    assert.equal(mine.data.bookings[0].trial, true);
    assert.equal(mine.data.bookings[0].cancellable, true);

    assert.equal((await req('/api/bookings/cancel', { method: 'POST', body: { phone: '0922000111', code: a.data.code } })).status, 404);
    assert.equal((await req('/api/bookings/cancel', { method: 'POST', body: { phone: '0912345678', code: a.data.code.toLowerCase() } })).status, 200);
    assert.equal((await req('/api/bookings/cancel', { method: 'POST', body: { phone: '0912345678', code: a.data.code } })).status, 409);
    const again = (await req('/api/slots?days=20')).data.slots.find((s) => s.id === slot.id);
    assert.equal(again.remaining, 1);
  });

  test('停課：學生看不到也不能預約，已預約的人會看到停課；恢復後重新開放', async () => {
    const slot = (await req('/api/slots?days=20')).data.slots.find((s) => s.title === '兒童班');
    assert.equal((await req(`/api/admin/slots/${slot.id}/cancel`, { method: 'POST', auth: token })).status, 200);
    assert.ok(!(await req('/api/slots?days=20')).data.slots.some((s) => s.id === slot.id));
    assert.equal((await req('/api/bookings', { method: 'POST', body: { slotId: slot.id, name: '阿強', phone: '0955111222' } })).status, 409);
    const mine = (await req('/api/bookings?phone=0922000111')).data.bookings.find((b) => b.startAt === slot.startAt);
    assert.equal(mine.slotCancelled, true);
    assert.equal(mine.cancellable, false);
    // 固定課表的課不能直接刪除（否則會被重新產生）
    assert.equal((await req(`/api/admin/slots/${slot.id}`, { method: 'DELETE', auth: token })).status, 409);
    // 停課的課不會被重新產生出來
    assert.ok(!(await req('/api/slots?days=20')).data.slots.some((s) => s.startAt === slot.startAt && s.title === '兒童班'));
    assert.equal((await req(`/api/admin/slots/${slot.id}/restore`, { method: 'POST', auth: token })).status, 200);
    assert.ok((await req('/api/slots?days=20')).data.slots.some((s) => s.id === slot.id));
  });

  test('上課前 2 小時內無法線上取消，過去的課不能預約', async () => {
    const soon = T.fromMs(T.toMs(T.nowLocal(TZ)) + 60 * 60000);
    const r = await req('/api/admin/slots', { method: 'POST', auth: token, body: {
      title: '急課', category: 'tkd', date: soon.slice(0, 10), time: soon.slice(11), duration: 60, capacity: 5,
    } });
    assert.equal(r.status, 201);
    const bk = await req('/api/bookings', { method: 'POST', body: { slotId: r.data.id, name: '阿強', phone: '0955111222' } });
    assert.equal(bk.status, 201);
    assert.equal((await req('/api/bookings/cancel', { method: 'POST', body: { phone: '0955111222', code: bk.data.code } })).status, 409);

    const past = T.fromMs(T.toMs(T.nowLocal(TZ)) - 60 * 60000);
    const p = await req('/api/admin/slots', { method: 'POST', auth: token, body: {
      title: '舊課', date: past.slice(0, 10), time: past.slice(11), duration: 60, capacity: 5,
    } });
    assert.equal((await req('/api/bookings', { method: 'POST', body: { slotId: p.data.id, name: '阿強', phone: '0955111222' } })).status, 409);
    assert.equal((await req(`/api/admin/slots/${p.data.id}`, { method: 'DELETE', auth: token })).status, 200);
  });

  test('後台：名單、修改名額、代約、刪除固定時段', async () => {
    const from = today(), to = T.addDays(from, 20);
    const { data } = await req(`/api/admin/slots?from=${from}&to=${to}`, { auth: token });
    const s = data.slots.find((x) => x.title === '兒童班' && x.booked === 1);
    assert.ok(s && s.fromTemplate);
    assert.equal(s.bookings.length, 2);
    assert.ok(s.bookings.some((b) => b.trial));

    const shrink = await req(`/api/admin/slots/${s.id}`, { method: 'PUT', auth: token, body: {
      title: s.title, date: s.startAt.slice(0, 10), time: s.startAt.slice(11), duration: 60, capacity: 0,
    } });
    assert.equal(shrink.status, 400);
    assert.equal((await req(`/api/admin/slots/${s.id}/bookings`, { method: 'POST', auth: token, body: { name: '小美', phone: '0933000111', trial: true } })).status, 201);

    const { data: t } = await req('/api/admin/templates', { auth: token });
    const del = await req(`/api/admin/templates/${t.templates[0].id}`, { method: 'DELETE', auth: token });
    assert.equal(del.status, 200);
    assert.equal(del.data.kept, 1); // 有人預約的那堂保留
    const left = (await req('/api/slots?days=29')).data.slots.filter((x) => x.title === '兒童班');
    assert.equal(left.length, 1);
  });

  test('靜態頁面與路徑安全', async () => {
    for (const p of ['/', '/my', '/info', '/admin', '/style.css', '/logo.png']) {
      assert.equal((await req(p)).status, 200, p);
    }
    assert.notEqual((await req('/..%2fserver.js')).status, 200);
  });
});

test('時間工具', () => {
  assert.equal(T.isValidDate('2026-02-30'), false);
  assert.equal(T.isValidDate('2026-02-28'), true);
  assert.equal(T.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(T.weekday('2026-11-22'), 0);
});
