'use strict';
const { test, before, after, describe } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
    assert.equal(data.templates[0].titleEn, 'Taekwon-Do');
    assert.equal(data.templates[0].subtitleEn, 'Age 12+');
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
  let req, server, base, token;
  before(async () => { ({ req, server, base } = await start({ seedSchedule: false })); });
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

  let ming, hua, mei, mingToken, huaToken;

  test('學員資料：新增、重複信箱、批次匯入', async () => {
    const r = await req('/api/admin/students', { method: 'POST', auth: token, body: { name: '小明', email: 'Ming@Example.com', phone: '0912-345-678' } });
    assert.equal(r.status, 201);
    ming = r.data.id;
    assert.equal((await req('/api/admin/students', { method: 'POST', auth: token, body: { name: '小明2', email: 'ming@example.com' } })).status, 409);
    assert.equal((await req('/api/admin/students', { method: 'POST', auth: token, body: { name: 'x', email: 'not-an-email' } })).status, 400);
    assert.equal((await req('/api/admin/students', { method: 'POST', body: { name: 'x', email: 'x@y.com' } })).status, 401);

    const b = await req('/api/admin/students/batch', { method: 'POST', auth: token, body: { students: [
      { name: '小華', email: 'hua@example.com' }, { name: '小美', email: 'mei@example.com', phone: '0933000111' },
      { name: '小明', email: 'ming@example.com' },
    ] } });
    assert.equal(b.status, 201);
    assert.deepEqual(b.data.created, ['hua@example.com', 'mei@example.com']);
    assert.deepEqual(b.data.skipped, ['ming@example.com']);
    const list = (await req('/api/admin/students', { auth: token })).data.students;
    assert.equal(list.length, 3);
    hua = list.find((x) => x.name === '小華').id;
    mei = list.find((x) => x.name === '小美').id;
  });

  test('學員用信箱登入；未建立的信箱、停用的帳號不能登入', async () => {
    assert.equal((await req('/api/login', { method: 'POST', body: { email: 'nobody@example.com' } })).status, 404);
    const r = await req('/api/login', { method: 'POST', body: { email: '  MING@example.com ' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.student.name, '小明');
    mingToken = r.data.token;
    assert.equal((await req('/api/me', { auth: mingToken })).data.student.email, 'ming@example.com');
    assert.equal((await req('/api/me')).status, 401);
    // 學員的登入不能進後台
    assert.equal((await req('/api/admin/students', { auth: mingToken })).status, 401);
    huaToken = (await req('/api/login', { method: 'POST', body: { email: 'hua@example.com' } })).data.token;

    assert.equal((await req(`/api/admin/students/${mei}/deactivate`, { method: 'POST', auth: token })).status, 200);
    assert.equal((await req('/api/login', { method: 'POST', body: { email: 'mei@example.com' } })).status, 403);
    assert.equal((await req(`/api/admin/students/${mei}/activate`, { method: 'POST', auth: token })).status, 200);
  });

  test('堂數卡：開卡、沒有堂數不能約', async () => {
    const tomorrowSlot = (await req('/api/slots?days=20')).data.slots.find((s) => s.title === '兒童班');
    const huaT = (await req('/api/login', { method: 'POST', body: { email: 'hua@example.com' } })).data.token;
    // 還沒開卡：不能約
    const no = await req('/api/bookings', { method: 'POST', auth: huaT, body: { slotId: tomorrowSlot.id } });
    assert.equal(no.status, 409);
    assert.match(no.data.error, /沒有可用的堂數/);
    assert.equal((await req(`/api/bookings/preview?slotId=${tomorrowSlot.id}`, { auth: huaT })).data.pass, null);

    const d = today(), end = T.addDays(d, 29);
    const mk = (id, body) => req(`/api/admin/students/${id}/passes`, { method: 'POST', auth: token, body });
    assert.equal((await mk(ming, { name: '8 堂月卡', total: 8, startDate: d, endDate: end })).status, 201);
    assert.equal((await mk(hua, { name: '兒童 1 堂', total: 1, startDate: d, endDate: end, categories: ['kids'] })).status, 201);
    assert.equal((await mk(mei, { name: '舊卡', total: 4, startDate: T.addDays(d, -60), endDate: T.addDays(d, -1) })).status, 201);
    assert.equal((await mk(ming, { name: 'x', total: 1, startDate: d, endDate: T.addDays(d, -1) })).status, 400);
    assert.equal((await req(`/api/bookings/preview?slotId=${tomorrowSlot.id}`, { auth: huaT })).data.pass.name, '兒童 1 堂');
  });

  test('學員預約：需要登入、名額、重複、額滿、取消', async () => {
    const slot = (await req('/api/slots?days=20')).data.slots.find((s) => s.title === '兒童班');
    assert.equal(slot.remaining, 2);
    assert.equal((await req('/api/bookings', { method: 'POST', body: { slotId: slot.id } })).status, 401);

    const a = await req('/api/bookings', { method: 'POST', auth: mingToken, body: { slotId: slot.id, note: '會晚到' } });
    assert.equal(a.status, 201);
    assert.equal(a.data.code, undefined); // 不再有預約代碼
    assert.equal((await req('/api/bookings', { method: 'POST', auth: mingToken, body: { slotId: slot.id } })).status, 409);
    // 登入後課表會標示自己預約的課
    assert.equal((await req('/api/slots?days=20', { auth: mingToken })).data.slots.find((s) => s.id === slot.id).mine, true);
    assert.equal((await req('/api/slots?days=20', { auth: huaToken })).data.slots.find((s) => s.id === slot.id).mine, false);

    assert.equal((await req('/api/bookings', { method: 'POST', auth: huaToken, body: { slotId: slot.id } })).status, 201);
    const meiToken = (await req('/api/login', { method: 'POST', body: { email: 'mei@example.com' } })).data.token;
    const c = await req('/api/bookings', { method: 'POST', auth: meiToken, body: { slotId: slot.id } });
    assert.equal(c.status, 409);
    assert.equal(c.data.error, '這堂課已額滿');

    const mine = (await req('/api/my/bookings', { auth: mingToken })).data.bookings;
    assert.equal(mine.length, 1);
    assert.equal(mine[0].cancellable, true);
    // 不能取消別人的預約
    assert.equal((await req(`/api/my/bookings/${mine[0].id}/cancel`, { method: 'POST', auth: huaToken })).status, 404);
    assert.equal((await req(`/api/my/bookings/${mine[0].id}/cancel`, { method: 'POST', auth: mingToken })).status, 200);
    assert.equal((await req(`/api/my/bookings/${mine[0].id}/cancel`, { method: 'POST', auth: mingToken })).status, 409);
    assert.equal((await req('/api/slots?days=20')).data.slots.find((s) => s.id === slot.id).remaining, 1);

    // 登出後 token 失效
    assert.equal((await req('/api/logout', { method: 'POST', auth: meiToken })).status, 200);
    assert.equal((await req('/api/me', { auth: meiToken })).status, 401);
  });

  test('停課：學員看不到也不能預約，已預約的人會看到停課；恢復後重新開放', async () => {
    const slot = (await req('/api/slots?days=20')).data.slots.find((s) => s.title === '兒童班');
    assert.equal((await req(`/api/admin/slots/${slot.id}/cancel`, { method: 'POST', auth: token })).status, 200);
    assert.ok(!(await req('/api/slots?days=20')).data.slots.some((s) => s.id === slot.id));
    assert.equal((await req('/api/bookings', { method: 'POST', auth: mingToken, body: { slotId: slot.id } })).status, 409);
    const mine = (await req('/api/my/bookings', { auth: huaToken })).data.bookings.find((b) => b.startAt === slot.startAt);
    assert.equal(mine.slotCancelled, true);
    assert.equal(mine.cancellable, false);
    assert.equal((await req(`/api/admin/slots/${slot.id}`, { method: 'DELETE', auth: token })).status, 409);
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
    assert.equal((await req('/api/bookings', { method: 'POST', auth: mingToken, body: { slotId: r.data.id } })).status, 201);
    const b = (await req('/api/my/bookings', { auth: mingToken })).data.bookings.find((x) => x.title === '急課');
    assert.equal(b.cancellable, false);
    assert.equal((await req(`/api/my/bookings/${b.id}/cancel`, { method: 'POST', auth: mingToken })).status, 409);

    const past = T.fromMs(T.toMs(T.nowLocal(TZ)) - 60 * 60000);
    const p = await req('/api/admin/slots', { method: 'POST', auth: token, body: {
      title: '舊課', date: past.slice(0, 10), time: past.slice(11), duration: 60, capacity: 5,
    } });
    assert.equal((await req('/api/bookings', { method: 'POST', auth: mingToken, body: { slotId: p.data.id } })).status, 409);
    assert.equal((await req(`/api/admin/slots/${p.data.id}`, { method: 'DELETE', auth: token })).status, 200);
  });

  test('後台：名單、修改名額、代約、學員紀錄、刪除學員、刪除固定時段', async () => {
    const from = today(), to = T.addDays(from, 20);
    const { data } = await req(`/api/admin/slots?from=${from}&to=${to}`, { auth: token });
    const s = data.slots.find((x) => x.title === '兒童班' && x.booked === 1);
    assert.ok(s && s.fromTemplate);
    assert.equal(s.bookings.length, 2);
    assert.ok(s.bookings.some((b) => b.name === '小華' && b.email === 'hua@example.com' && b.status === 'active'));

    const shrink = await req(`/api/admin/slots/${s.id}`, { method: 'PUT', auth: token, body: {
      title: s.title, date: s.startAt.slice(0, 10), time: s.startAt.slice(11), duration: 60, capacity: 0,
    } });
    assert.equal(shrink.status, 400);
    const add = await req(`/api/admin/slots/${s.id}/bookings`, { method: 'POST', auth: token, body: { studentId: mei, trial: true } });
    assert.equal(add.status, 201);
    const roster = (await req(`/api/admin/slots?from=${from}&to=${to}`, { auth: token })).data.slots.find((x) => x.id === s.id).bookings;
    assert.ok(roster.some((b) => b.name === '小美' && b.trial && b.bookedBy === 'admin'));

    const hist = await req(`/api/admin/students/${mei}/bookings`, { auth: token });
    assert.equal(hist.data.bookings.length, 1);
    // 有預約紀錄的學員不能刪除；沒有紀錄的可以
    assert.equal((await req(`/api/admin/students/${mei}`, { method: 'DELETE', auth: token })).status, 409);
    const tmp = await req('/api/admin/students', { method: 'POST', auth: token, body: { name: '路人', email: 'tmp@example.com' } });
    assert.equal((await req(`/api/admin/students/${tmp.data.id}`, { method: 'DELETE', auth: token })).status, 200);
    // 編輯學員信箱：不能和別人重複
    assert.equal((await req(`/api/admin/students/${hua}`, { method: 'PUT', auth: token, body: { name: '小華', email: 'ming@example.com' } })).status, 409);
    assert.equal((await req(`/api/admin/students/${hua}`, { method: 'PUT', auth: token, body: { name: '小華', email: 'hua2@example.com' } })).status, 200);
    assert.equal((await req('/api/login', { method: 'POST', body: { email: 'hua2@example.com' } })).status, 200);

    const { data: t } = await req('/api/admin/templates', { auth: token });
    const del = await req(`/api/admin/templates/${t.templates[0].id}`, { method: 'DELETE', auth: token });
    assert.equal(del.status, 200);
    assert.equal(del.data.kept, 1);
    assert.equal((await req('/api/slots?days=29')).data.slots.filter((x) => x.title === '兒童班').length, 1);
  });

  test('經由平台用 http 進來會轉到 https', async () => {
    const r = await fetch(base + '/my?x=1', { redirect: 'manual', headers: { 'X-Forwarded-Proto': 'http' } });
    assert.equal(r.status, 301);
    assert.equal(r.headers.get('location'), base.replace('http://', 'https://') + '/my?x=1');
    const ok = await fetch(base + '/', { redirect: 'manual', headers: { 'X-Forwarded-Proto': 'https' } });
    assert.equal(ok.status, 200);
  });

  test('堂數卡：扣堂、取消退回、停課退回、適用課程、過期、作廢、代約不扣堂', async () => {
    const d = today();
    const mkSlot = async (title, category, days) => {
      const date = T.addDays(d, days);
      return (await req('/api/admin/slots', { method: 'POST', auth: token, body: {
        title, category, date, time: '20:00', duration: 60, capacity: 10 } })).data.id;
    };
    const st = (await req('/api/admin/students', { method: 'POST', auth: token, body: { name: '阿卡', email: 'card@example.com' } })).data.id;
    const t = (await req('/api/login', { method: 'POST', body: { email: 'card@example.com' } })).data.token;
    const mk = (body) => req(`/api/admin/students/${st}/passes`, { method: 'POST', auth: token, body });
    const passes = async () => (await req(`/api/admin/students/${st}/passes`, { auth: token })).data.passes;
    const book = (slotId) => req('/api/bookings', { method: 'POST', auth: t, body: { slotId } });

    // 兩張卡：快到期的 2 堂（只限 tkd）、晚到期的 1 堂（全部課程）
    const a = (await mk({ name: '短卡', total: 2, startDate: d, endDate: T.addDays(d, 5), categories: ['tkd'] })).data.id;
    const b = (await mk({ name: '長卡', total: 1, startDate: d, endDate: T.addDays(d, 20) })).data.id;
    const s1 = await mkSlot('A', 'tkd', 1), s2 = await mkSlot('B', 'tkd', 2), s3 = await mkSlot('C', 'kids', 3);
    const s4 = await mkSlot('D', 'tkd', 10), s5 = await mkSlot('E', 'tkd', 25);

    const r1 = await book(s1);
    assert.equal(r1.data.pass.name, '短卡'); // 先扣最快到期的
    assert.equal(r1.data.pass.remaining, 1);
    assert.equal((await book(s3)).data.pass.name, '長卡'); // 短卡不適用 kids，改扣長卡
    assert.equal((await book(s2)).data.pass.name, '短卡');
    let ps = await passes();
    assert.equal(ps.find((p) => p.id === a).status, 'used');
    // 堂數用完
    assert.match((await book(s4)).data.error, /沒有可用的堂數/);
    // 超過有效期限的課不能用這些卡
    assert.match((await book(s5)).data.error, /沒有可用的堂數/);

    // 學員取消 → 退回堂數
    const mine = (await req('/api/my/bookings', { auth: t })).data.bookings;
    const bk1 = mine.find((x) => x.title === 'A');
    assert.equal(bk1.passName, '短卡');
    assert.equal((await req(`/api/my/bookings/${bk1.id}/cancel`, { method: 'POST', auth: t })).status, 200);
    assert.equal((await passes()).find((p) => p.id === a).remaining, 1);
    // 老師停課 → 退回；恢復 → 再扣
    await req(`/api/admin/slots/${s2}/cancel`, { method: 'POST', auth: token });
    assert.equal((await passes()).find((p) => p.id === a).remaining, 2);
    await req(`/api/admin/slots/${s2}/restore`, { method: 'POST', auth: token });
    assert.equal((await passes()).find((p) => p.id === a).remaining, 1);

    // 總堂數不能改成少於已用；可以加堂數
    const upd = (total) => req(`/api/admin/passes/${a}`, { method: 'PUT', auth: token, body: {
      name: '短卡', total, startDate: d, endDate: T.addDays(d, 5), categories: ['tkd'] } });
    assert.equal((await upd(0)).status, 400);
    assert.equal((await req(`/api/admin/passes/${b}`, { method: 'PUT', auth: token, body: {
      name: '長卡', total: 1, startDate: d, endDate: T.addDays(d, 20) } })).status, 200);

    // 作廢後不能再用；用過的卡不能刪除
    assert.equal((await req(`/api/admin/passes/${a}/void`, { method: 'POST', auth: token })).status, 200);
    assert.match((await book(s4)).data.error, /沒有可用的堂數/);
    assert.equal((await req(`/api/admin/passes/${a}`, { method: 'DELETE', auth: token })).status, 409);
    assert.equal((await req('/api/my/passes', { auth: t })).data.passes.some((p) => p.id === a), false);
    const unused = (await mk({ name: '開錯', total: 3, startDate: d, endDate: T.addDays(d, 5) })).data.id;
    assert.equal((await req(`/api/admin/passes/${unused}`, { method: 'DELETE', auth: token })).status, 200);

    // 老師代約：沒有堂數也可以，名單標示未扣堂
    const add = await req(`/api/admin/slots/${s4}/bookings`, { method: 'POST', auth: token, body: { studentId: st } });
    assert.equal(add.status, 201);
    assert.equal(add.data.pass, null);
    const roster = (await req(`/api/admin/slots?from=${d}&to=${T.addDays(d, 12)}`, { auth: token })).data.slots
      .find((x) => x.id === s4).bookings;
    assert.equal(roster[0].passName, null);

    // 購買日：預設今天、可指定、不能晚於今天
    const pp = await passes();
    assert.ok(pp.every((p) => p.purchaseDate === d));
    const withDate = await mk({ name: '補登', total: 2, purchaseDate: T.addDays(d, -10), startDate: d, endDate: T.addDays(d, 5) });
    assert.equal(withDate.status, 201);
    assert.equal((await passes()).find((p) => p.id === withDate.data.id).purchaseDate, T.addDays(d, -10));
    assert.equal((await mk({ name: 'x', total: 1, purchaseDate: T.addDays(d, 1), startDate: d, endDate: d })).status, 400);
    await req(`/api/admin/passes/${withDate.data.id}/void`, { method: 'POST', auth: token });

    // 學員列表摘要
    const me = (await req('/api/admin/students', { auth: token })).data.students.find((x) => x.id === st);
    assert.equal(me.credits.remaining, 0);
  });

  test('生日與當月壽星', async () => {
    const d = today();
    const ym = d.slice(0, 7);
    const born = `2015-${d.slice(5, 7)}-01`;           // 本月 1 日生
    const other = d.slice(5, 7) === '06' ? '2010-07-15' : '2010-06-15'; // 別的月份
    const mk = (name, email, birthday) => req('/api/admin/students', { method: 'POST', auth: token, body: { name, email, birthday } });
    assert.equal((await mk('壽星', 'bday@example.com', born.replace(/-/g, '/'))).status, 201); // 接受 2015/11/01 寫法
    assert.equal((await mk('別月', 'other@example.com', other)).status, 201);
    assert.equal((await mk('錯誤', 'bad@example.com', '2015-02-30')).status, 400);
    assert.equal((await mk('未來', 'future@example.com', '2099-01-01')).status, 400);

    const r = await req('/api/admin/birthdays', { auth: token });
    assert.equal(r.data.month, ym);
    const hit = r.data.students.find((x) => x.name === '壽星');
    assert.ok(hit);
    assert.equal(hit.birthday, born);
    assert.equal(hit.age, Number(ym.slice(0, 4)) - 2015);
    assert.ok(!r.data.students.some((x) => x.name === '別月'));
    const other2 = await req(`/api/admin/birthdays?month=${ym.slice(0, 4)}-${other.slice(5, 7)}`, { auth: token });
    assert.ok(other2.data.students.some((x) => x.name === '別月'));
    assert.equal((await req('/api/admin/birthdays')).status, 401);
    // 停用的學員不列入
    const id = (await req('/api/admin/students', { auth: token })).data.students.find((x) => x.name === '壽星').id;
    await req(`/api/admin/students/${id}/deactivate`, { method: 'POST', auth: token });
    assert.ok(!(await req('/api/admin/birthdays', { auth: token })).data.students.some((x) => x.name === '壽星'));
  });

  test('靜態頁面與路徑安全', async () => {
    for (const p of ['/', '/my', '/info', '/admin', '/style.css', '/logo.png']) {
      assert.equal((await req(p)).status, 200, p);
    }
    assert.notEqual((await req('/..%2fserver.js')).status, 200);
  });
});

test('舊版資料庫（預約代碼）可以升級', () => {
  const { DatabaseSync } = require('node:sqlite');
  const { openDb, createStore } = require('../lib/db');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bk-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE slots (id INTEGER PRIMARY KEY, title TEXT NOT NULL, start_at TEXT NOT NULL, duration_min INTEGER NOT NULL,
      capacity INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE bookings (id INTEGER PRIMARY KEY, slot_id INTEGER NOT NULL REFERENCES slots(id), name TEXT NOT NULL,
      phone TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', code TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT, cancelled_at TEXT);
    CREATE INDEX idx_bookings_slot ON bookings(slot_id);
    INSERT INTO slots (title, start_at, duration_min, capacity) VALUES ('舊課', '2030-01-01T10:00', 60, 5);
    INSERT INTO bookings (slot_id, name, phone, code) VALUES (1, 'a', '0912345678', 'ABCDEF');`);
  old.close();
  const db = openDb(file);
  const st = createStore(db);
  assert.equal(st.getSlot(1).booked, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bookings_legacy').get().n, 1);
  const sid = st.createStudent({ name: 'a', email: 'a@b.co', phone: '', note: '' });
  assert.ok(st.book({ slotId: 1, studentId: sid, note: '', isOpen: () => true }).booking);
  db.close();
});

test('舊版課程副標題升級成英文課名', () => {
  const { DatabaseSync } = require('node:sqlite');
  const { openDb } = require('../lib/db');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bk-')), 'old2.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE templates (id INTEGER PRIMARY KEY, title TEXT NOT NULL, subtitle TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'other', weekday INTEGER NOT NULL, time TEXT NOT NULL, duration_min INTEGER NOT NULL,
      capacity INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO templates (title, subtitle, weekday, time, duration_min, capacity) VALUES
      ('跆拳道', 'Taekwon-Do・12歲以上', 1, '10:30', 90, 20), ('私人', 'Private Session', 5, '12:30', 60, 1), ('自訂', '中文副標', 2, '10:00', 60, 5);`);
  old.close();
  const db = openDb(file);
  const rows = db.prepare('SELECT title_en, subtitle, subtitle_en FROM templates ORDER BY id').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { title_en: 'Taekwon-Do', subtitle: '12歲以上', subtitle_en: 'Age 12+' },
    { title_en: 'Private Session', subtitle: '', subtitle_en: '' },
    { title_en: '', subtitle: '中文副標', subtitle_en: '' },
  ]);
  db.close();
});

test('時間工具', () => {
  assert.equal(T.isValidDate('2026-02-30'), false);
  assert.equal(T.isValidDate('2026-02-28'), true);
  assert.equal(T.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(T.weekday('2026-11-22'), 0);
});
