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
  const PW = 'pass1234';
  /** 學員登入；還沒設定密碼的舊生，先用老師產生的連結設定密碼。 */
  async function login(email) {
    let r = await req('/api/login', { method: 'POST', body: { email, password: PW } });
    if (r.data && r.data.code === 'NO_PASSWORD') {
      const st = (await req('/api/admin/students', { auth: token })).data.students
        .find((x) => x.email.toLowerCase() === email.trim().toLowerCase());
      const link = (await req(`/api/admin/students/${st.id}/reset-link`, { method: 'POST', auth: token })).data.url;
      await req('/api/password/reset', { method: 'POST', body: { token: new URL(link).searchParams.get('token'), password: PW } });
      r = await req('/api/login', { method: 'POST', body: { email, password: PW } });
    }
    return r;
  }
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
    // 同信箱同名 → 重複；同信箱不同名（兄弟姊妹）在家庭帳號測試另外驗證
    assert.equal((await req('/api/admin/students', { method: 'POST', auth: token, body: { name: '小明', email: 'ming@example.com' } })).status, 409);
    assert.equal((await req('/api/admin/students', { method: 'POST', auth: token, body: { name: 'x', email: 'not-an-email' } })).status, 400);
    assert.equal((await req('/api/admin/students', { method: 'POST', body: { name: 'x', email: 'x@y.com' } })).status, 401);

    const b = await req('/api/admin/students/batch', { method: 'POST', auth: token, body: { students: [
      { name: '小華', email: 'hua@example.com' }, { name: '小美', email: 'mei@example.com', phone: '0933000111' },
      { name: '小明', email: 'ming@example.com' },
    ] } });
    assert.equal(b.status, 201);
    assert.deepEqual(b.data.created, ['小華 <hua@example.com>', '小美 <mei@example.com>']);
    assert.deepEqual(b.data.skipped, ['小明 <ming@example.com>']);
    const list = (await req('/api/admin/students', { auth: token })).data.students;
    assert.equal(list.length, 3);
    hua = list.find((x) => x.name === '小華').id;
    mei = list.find((x) => x.name === '小美').id;
  });

  test('學員用信箱登入；未建立的信箱、停用的帳號不能登入', async () => {
    assert.equal((await login('nobody@example.com')).status, 401);
    const r = await login('  MING@example.com ');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.students.map((x) => x.name), ['小明']);
    mingToken = r.data.token;
    assert.equal((await req('/api/me', { auth: mingToken })).data.students[0].email, 'ming@example.com');
    assert.equal((await req('/api/me')).status, 401);
    // 學員的登入不能進後台
    assert.equal((await req('/api/admin/students', { auth: mingToken })).status, 401);
    huaToken = (await login('hua@example.com')).data.token;

    assert.equal((await req(`/api/admin/students/${mei}/deactivate`, { method: 'POST', auth: token })).status, 200);
    assert.equal((await login('mei@example.com')).status, 403);
    assert.equal((await req(`/api/admin/students/${mei}/activate`, { method: 'POST', auth: token })).status, 200);
  });

  test('堂數卡：開卡、沒有堂數不能約', async () => {
    const tomorrowSlot = (await req('/api/slots?days=20')).data.slots.find((s) => s.title === '兒童班');
    const huaT = (await login('hua@example.com')).data.token;
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
    const meiToken = (await login('mei@example.com')).data.token;
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
    assert.equal((await req(`/api/admin/students/${hua}`, { method: 'PUT', auth: token, body: { name: '小明', email: 'ming@example.com' } })).status, 409);
    assert.equal((await req(`/api/admin/students/${hua}`, { method: 'PUT', auth: token, body: { name: '小華', email: 'hua2@example.com' } })).status, 200);
    assert.equal((await login('hua2@example.com')).status, 200);

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
    const t = (await login('card@example.com')).data.token;
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

  test('同一個信箱多位學員（家庭帳號）', async () => {
    const d = today();
    const add = (name) => req('/api/admin/students', { method: 'POST', auth: token, body: { name, email: 'Family@Example.com' } });
    const bro = (await add('哥哥')).data.id;
    const sis = (await add('妹妹')).data.id;
    assert.ok(bro && sis);
    // 批次匯入：同信箱不同名會新增、同名略過
    const imp = await req('/api/admin/students/batch', { method: 'POST', auth: token, body: { students: [
      { name: '弟弟', email: 'family@example.com' }, { name: '妹妹', email: 'family@example.com' }] } });
    assert.deepEqual(imp.data.created, ['弟弟 <family@example.com>']);
    assert.deepEqual(imp.data.skipped, ['妹妹 <family@example.com>']);
    const all = (await req('/api/admin/students', { auth: token })).data.students;
    const kid = all.find((x) => x.name === '弟弟').id;
    await req(`/api/admin/students/${kid}/deactivate`, { method: 'POST', auth: token });

    // 登入列出啟用中的家庭成員
    const lg = await login('family@example.com');
    assert.equal(lg.status, 200);
    assert.deepEqual(lg.data.students.map((x) => x.name), ['哥哥', '妹妹']);
    const t = lg.data.token;

    // 各自的堂數
    const mk = (id, n) => req(`/api/admin/students/${id}/passes`, { method: 'POST', auth: token,
      body: { name: `${n} 堂`, total: n, startDate: d, endDate: T.addDays(d, 20) } });
    await mk(bro, 2); await mk(sis, 1);
    const slot = (await req('/api/admin/slots', { method: 'POST', auth: token, body: {
      title: '家庭課', date: T.addDays(d, 3), time: '18:00', duration: 60, capacity: 5 } })).data.id;

    // 兩位以上時必須指定學員
    assert.equal((await req('/api/bookings', { method: 'POST', auth: t, body: { slotId: slot } })).status, 400);
    assert.equal((await req(`/api/bookings/preview?slotId=${slot}&studentId=${sis}`, { auth: t })).data.pass.name, '1 堂');
    // 不能幫別的信箱的學員或已停用的成員預約
    assert.equal((await req('/api/bookings', { method: 'POST', auth: t, body: { slotId: slot, studentId: ming } })).status, 403);
    assert.equal((await req('/api/bookings', { method: 'POST', auth: t, body: { slotId: slot, studentId: kid } })).status, 403);

    const b1 = await req('/api/bookings', { method: 'POST', auth: t, body: { slotId: slot, studentId: bro } });
    assert.equal(b1.status, 201);
    assert.equal(b1.data.student.name, '哥哥');
    assert.equal(b1.data.pass.remaining, 1);
    // 同一堂課，妹妹也可以約（扣妹妹自己的卡）
    const b2 = await req('/api/bookings', { method: 'POST', auth: t, body: { slotId: slot, studentId: sis } });
    assert.equal(b2.status, 201);
    assert.equal(b2.data.pass.remaining, 0);
    assert.equal((await req('/api/bookings', { method: 'POST', auth: t, body: { slotId: slot, studentId: sis } })).status, 409);

    const sl = (await req('/api/slots?days=10', { auth: t })).data.slots.find((x) => x.id === slot);
    assert.deepEqual(sl.mineIds.sort(), [bro, sis].sort());

    const my = (await req('/api/my/bookings', { auth: t })).data;
    assert.equal(my.students.length, 2);
    assert.deepEqual(my.bookings.filter((x) => x.title === '家庭課').map((x) => x.studentName), ['哥哥', '妹妹']);
    const passes = (await req('/api/my/passes', { auth: t })).data.passes;
    assert.deepEqual(passes.map((p) => `${p.studentName}:${p.remaining}`).sort(), ['哥哥:1', '妹妹:0']);

    // 用同一個登入取消妹妹的預約
    const sisBooking = my.bookings.find((x) => x.studentName === '妹妹' && x.title === '家庭課');
    assert.equal((await req(`/api/my/bookings/${sisBooking.id}/cancel`, { method: 'POST', auth: t })).status, 200);
    // 別的帳號不能取消這個家庭的預約
    const broBooking = my.bookings.find((x) => x.studentName === '哥哥' && x.title === '家庭課');
    assert.equal((await req(`/api/my/bookings/${broBooking.id}/cancel`, { method: 'POST', auth: mingToken })).status, 404);

    // 停用其中一位：另一位照常可用；全部停用才不能登入
    await req(`/api/admin/students/${bro}/deactivate`, { method: 'POST', auth: token });
    assert.deepEqual((await req('/api/me', { auth: t })).data.students.map((x) => x.name), ['妹妹']);
    // 只剩一位時不用指定學員
    const solo = await req('/api/bookings', { method: 'POST', auth: t, body: { slotId: slot } });
    assert.equal(solo.status, 201); // 剛才取消退回 1 堂，所以可以再約
    assert.equal(solo.data.student.name, '妹妹');
  });

  test('堂數卡：補登、手動扣／補回、修改已用堂數、展延、換方案、異動紀錄', async () => {
    const d = today();
    const st = (await req('/api/admin/students', { method: 'POST', auth: token, body: { name: '補登生', email: 'back@example.com' } })).data.id;
    const list = async () => (await req(`/api/admin/students/${st}/passes`, { auth: token })).data.passes;
    // 補登：上個月買的 8 堂卡，紙本記錄已上 3 堂
    const mk = await req(`/api/admin/students/${st}/passes`, { method: 'POST', auth: token, body: {
      name: '8 堂月卡', total: 8, purchaseDate: T.addDays(d, -20), startDate: T.addDays(d, -20), endDate: T.addDays(d, 9), used: 3 } });
    assert.equal(mk.status, 201);
    const id = mk.data.id;
    let p = (await list())[0];
    assert.equal(p.used, 3); assert.equal(p.remaining, 5); assert.equal(p.bookedUsed, 0); assert.equal(p.adjust, 3);
    assert.equal((await req(`/api/admin/students/${st}/passes`, { method: 'POST', auth: token, body: {
      name: 'x', total: 2, startDate: d, endDate: d, used: 5 } })).status, 400); // 已用不能超過總堂數

    // 現場上課沒預約：扣 1 堂；扣錯補回
    const adj = (delta) => req(`/api/admin/passes/${id}/adjust`, { method: 'POST', auth: token, body: { delta } });
    assert.equal((await adj(1)).data.pass.remaining, 4);
    assert.equal((await adj(-1)).data.pass.remaining, 5);
    // 系統預約也照常扣
    const slot = (await req('/api/admin/slots', { method: 'POST', auth: token, body: {
      title: '補登課', date: T.addDays(d, 1), time: '09:00', duration: 60, capacity: 5 } })).data.id;
    await req(`/api/admin/slots/${slot}/bookings`, { method: 'POST', auth: token, body: { studentId: st } });
    p = (await list())[0];
    assert.equal(p.used, 4); assert.equal(p.bookedUsed, 1);

    // 直接改已用堂數 → 自動換算手動調整
    const put = (body) => req(`/api/admin/passes/${id}`, { method: 'PUT', auth: token, body: {
      name: '8 堂月卡', total: 8, purchaseDate: T.addDays(d, -20), startDate: T.addDays(d, -20), endDate: T.addDays(d, 9), ...body } });
    assert.equal((await put({ used: 6 })).status, 200);
    p = (await list())[0];
    assert.equal(p.used, 6); assert.equal(p.adjust, 5); assert.equal(p.remaining, 2);
    assert.equal((await put({ used: 9 })).status, 409); // 超過總堂數

    // 換方案：8 堂 → 12 堂，已用保留
    assert.equal((await put({ name: '12 堂月卡', total: 12 })).status, 200);
    p = (await list())[0];
    assert.equal(p.name, '12 堂月卡'); assert.equal(p.used, 6); assert.equal(p.remaining, 6);

    // 展延
    const ext = await req(`/api/admin/passes/${id}/extend`, { method: 'POST', auth: token, body: { endDate: T.addDays(d, 40), reason: '受傷請假' } });
    assert.equal(ext.status, 200);
    assert.equal(ext.data.pass.endDate, T.addDays(d, 40));
    assert.equal((await req(`/api/admin/passes/${id}/extend`, { method: 'POST', auth: token, body: { endDate: T.addDays(d, -30) } })).status, 400);

    // 不能扣超過、不能補到負數
    assert.equal((await put({ name: '12 堂月卡', total: 12, endDate: T.addDays(d, 40), used: 12 })).status, 200);
    assert.equal((await adj(1)).status, 409);

    // 異動紀錄
    p = (await list())[0];
    const actions = p.logs.map((l) => l.action).reverse();
    assert.deepEqual(actions, ['create', 'adjust', 'adjust', 'edit', 'edit', 'extend', 'edit']);
    assert.deepEqual(p.logs.find((l) => l.action === 'extend').detail.reason, '受傷請假');
    assert.ok(p.logs.some((l) => l.action === 'edit' && l.detail.changes.some(([k, a, b]) => k === 'total' && a === 8 && b === 12)));
    // 有手動調整紀錄的卡不能刪除
    const fresh = (await req(`/api/admin/students/${st}/passes`, { method: 'POST', auth: token, body: {
      name: '空卡', total: 1, startDate: d, endDate: d, used: 1 } })).data.id;
    assert.equal((await req(`/api/admin/passes/${fresh}`, { method: 'DELETE', auth: token })).status, 409);
  });

  test('無限堂：不限堂數、優先使用、可展延', async () => {
    const d = today();
    const st = (await req('/api/admin/students', { method: 'POST', auth: token, body: { name: '無限生', email: 'unl@example.com' } })).data.id;
    const t = (await login('unl@example.com')).data.token;
    const mk = (body) => req(`/api/admin/students/${st}/passes`, { method: 'POST', auth: token, body });
    // 一般卡先開、而且比較早到期；無限堂應該優先使用，一般卡不會被扣
    const normal = (await mk({ name: '4 堂', total: 4, startDate: d, endDate: T.addDays(d, 10) })).data.id;
    const unl = (await mk({ name: '無限堂月卡', unlimited: true, startDate: d, endDate: T.addDays(d, 20), categories: ['tkd'] })).data.id;
    assert.ok(unl);
    const slots = [];
    for (let i = 1; i <= 6; i++) {
      slots.push((await req('/api/admin/slots', { method: 'POST', auth: token, body: {
        title: `U${i}`, category: 'tkd', date: T.addDays(d, i), time: '07:00', duration: 60, capacity: 5 } })).data.id);
    }
    for (const id of slots) {
      const r = await req('/api/bookings', { method: 'POST', auth: t, body: { slotId: id } });
      assert.equal(r.status, 201);
      assert.equal(r.data.pass.unlimited, true);
      assert.equal(r.data.pass.remaining, null);
    }
    const ps = (await req(`/api/admin/students/${st}/passes`, { auth: token })).data.passes;
    const u = ps.find((p) => p.id === unl), n = ps.find((p) => p.id === normal);
    assert.equal(u.used, 6); assert.equal(u.status, 'active');
    assert.equal(n.used, 0); // 一般卡完全沒被扣
    // 無限堂不適用的課（kids）改扣一般卡
    const kids = (await req('/api/admin/slots', { method: 'POST', auth: token, body: {
      title: 'K', category: 'kids', date: T.addDays(d, 2), time: '08:00', duration: 60, capacity: 5 } })).data.id;
    assert.equal((await req('/api/bookings', { method: 'POST', auth: t, body: { slotId: kids } })).data.pass.name, '4 堂');
    // 學員列表摘要
    const me = (await req('/api/admin/students', { auth: token })).data.students.find((x) => x.id === st);
    assert.equal(me.credits.unlimited, true);
    assert.equal(me.credits.unlimitedUntil, T.addDays(d, 20));
    assert.equal(me.credits.remaining, 3);
    // 手動扣堂不受上限限制；展延照常
    assert.equal((await req(`/api/admin/passes/${unl}/adjust`, { method: 'POST', auth: token, body: { delta: 1 } })).data.pass.used, 7);
    assert.equal((await req(`/api/admin/passes/${unl}/extend`, { method: 'POST', auth: token, body: { endDate: T.addDays(d, 50) } })).status, 200);
    // 一般卡改成無限堂（換方案）也可以，並記錄在異動紀錄
    assert.equal((await req(`/api/admin/passes/${normal}`, { method: 'PUT', auth: token, body: {
      name: '無限堂月卡', unlimited: true, startDate: d, endDate: T.addDays(d, 10) } })).status, 200);
    const n2 = (await req(`/api/admin/students/${st}/passes`, { auth: token })).data.passes.find((p) => p.id === normal);
    assert.equal(n2.unlimited, true);
    assert.ok(n2.logs[0].detail.changes.some(([k, a, b]) => k === 'unlimited' && a === false && b === true));
    // 學員端看得到
    const my = (await req('/api/my/passes', { auth: t })).data.passes;
    assert.ok(my.every((p) => p.unlimited && p.remaining === null));
  });

  test('場地租借：只能租空檔、各類型上限、費用、取消、後台代訂', async () => {
    const d = T.addDays(today(), 3);
    const cfgR = (await req('/api/rentals/config')).data;
    assert.equal(cfgR.types.group.rate, 600); assert.equal(cfgR.types.private.cap, 3); assert.equal(cfgR.types.self.cap, 6);
    const st = (await req('/api/admin/students', { method: 'POST', auth: token, body: { name: '租場地', email: 'rent@example.com' } })).data.id;
    const t = (await login('rent@example.com')).data.token;
    // 10:00–11:00 有課
    const cls = (await req('/api/admin/slots', { method: 'POST', auth: token, body: {
      title: '早課', date: d, time: '10:00', duration: 60, capacity: 5 } })).data.id;
    const av = (await req(`/api/rentals/availability?date=${d}`)).data.segments;
    assert.equal(av.find((x) => x.time === '10:00').classBusy, true);
    assert.equal(av.find((x) => x.time === '10:30').classBusy, true);
    assert.equal(av.find((x) => x.time === '11:00').classBusy, false);

    const rent = (body, auth = t) => req('/api/rentals', { method: 'POST', auth, body: { date: d, hours: 1, ...body } });
    assert.equal((await rent({ type: 'group', start: '12:00' }, null)).status, 401);       // 要登入
    assert.equal((await rent({ type: 'group', start: '10:30' })).status, 409);             // 和課程重疊
    assert.equal((await rent({ type: 'group', start: '12:15' })).status, 400);             // 要整點或半點
    assert.equal((await rent({ type: 'group', start: '12:00', hours: 0.5 })).status, 400); // 至少 1 小時
    assert.equal((await rent({ type: 'group', start: '21:30' })).status, 400);             // 超過開放時間
    const g = await rent({ type: 'group', start: '11:00', hours: 2 });
    assert.equal(g.status, 201);
    assert.equal(g.data.rental.price, 1200);
    assert.equal((await rent({ type: 'private', start: '12:30' })).status, 409);           // 包場時段

    // 一對一最多 3 組
    for (let i = 0; i < 3; i++) assert.equal((await rent({ type: 'private', start: '14:00' })).status, 201);
    const fourth = await rent({ type: 'private', start: '14:30' });
    assert.equal(fourth.status, 409);
    assert.match(fourth.data.error, /3 組/);
    assert.equal((await rent({ type: 'group', start: '14:00' })).status, 409);             // 已有人租就不能包場
    // 自主訓練最多 6 人（可以和一對一同時）
    assert.equal((await rent({ type: 'self', start: '14:00', people: 4 })).data.rental.price, 400);
    const over = await rent({ type: 'self', start: '14:30', people: 3 });
    assert.equal(over.status, 409);
    assert.match(over.data.error, /只剩 2/);
    assert.equal((await rent({ type: 'self', start: '14:30', people: 2, hours: 1.5 })).data.rental.price, 300);
    assert.equal((await rent({ type: 'self', start: '15:00', people: 7 })).status, 400);

    // 我的租借、取消後空出名額
    const mine = (await req('/api/my/rentals', { auth: t })).data.rentals;
    assert.equal(mine.length, 6);
    const p1 = mine.find((r) => r.type === 'private');
    assert.equal((await req(`/api/my/rentals/${p1.id}/cancel`, { method: 'POST', auth: t })).status, 200);
    assert.equal((await rent({ type: 'private', start: '14:00' })).status, 201);
    assert.equal((await req(`/api/my/rentals/${p1.id}/cancel`, { method: 'POST', auth: mingToken })).status, 404); // 別人的

    // 停課後時段空出來
    await req(`/api/admin/slots/${cls}/cancel`, { method: 'POST', auth: token });
    assert.equal((await rent({ type: 'self', start: '10:00' })).status, 201);
    await req(`/api/admin/slots/${cls}/restore`, { method: 'POST', auth: token });

    // 後台代訂：每週重複；其中一週衝突就全部不建立
    const add = (body) => req('/api/admin/rentals', { method: 'POST', auth: token, body: {
      contactName: '外部教練', contactPhone: '0911222333', type: 'group', date: d, start: '19:00', hours: 1, ...body } });
    const r3 = await add({ repeatWeeks: 3 });
    assert.equal(r3.status, 201, JSON.stringify(r3.data)); assert.equal(r3.data.created, 3); assert.equal(r3.data.price, 600);
    const conflict = (await req('/api/admin/slots', { method: 'POST', auth: token, body: {
      title: '擋', date: T.addDays(d, 7), time: '20:00', duration: 60, capacity: 5 } })).data.id;
    assert.ok(conflict);
    const bad = await add({ start: '20:30', hours: 1, repeatWeeks: 2 });   // 第 2 週 20:00 有課
    assert.equal(bad.status, 409);
    const list = (await req(`/api/admin/rentals?from=${d}&to=${T.addDays(d, 30)}`, { auth: token })).data.rentals;
    assert.equal(list.filter((r) => r.contactName === '外部教練').length, 3); // 沒有多建
    const one = list.find((r) => r.contactName === '外部教練');
    assert.equal((await req(`/api/admin/rentals/${one.id}/paid`, { method: 'POST', auth: token, body: { paid: true } })).status, 200);
    assert.equal((await req(`/api/admin/rentals/${one.id}/cancel`, { method: 'POST', auth: token })).status, 200);
    const after = (await req(`/api/admin/rentals?from=${d}&to=${T.addDays(d, 1)}`, { auth: token })).data.rentals.find((r) => r.id === one.id);
    assert.equal(after.paid, true); assert.equal(after.status, 'cancelled');
    assert.equal((await req('/api/admin/rentals', { auth: t })).status, 401);
  });

  test('報表匯出：依期間、依學員，JSON 與 Excel', async () => {
    const from = T.addDays(today(), -30), to = T.addDays(today(), 60);
    const r = await req(`/api/admin/report?from=${from}&to=${to}`, { auth: token });
    assert.equal(r.status, 200);
    assert.ok(r.data.bookings.length > 0);
    assert.ok(r.data.rentals.length > 0);
    assert.equal(r.data.headers.bookings[0], '日期');
    assert.ok(r.data.perStudent.length > 0);
    const rentAmount = r.data.summary.find(([k]) => k === '場地租借金額')[1];
    assert.ok(rentAmount > 0);
    // 指定學員
    const st = (await req('/api/admin/students', { auth: token })).data.students.find((x) => x.name === '租場地');
    const one = (await req(`/api/admin/report?from=${from}&to=${to}&studentId=${st.id}`, { auth: token })).data;
    assert.ok(one.rentals.length > 0 && one.rentals.every((x) => x[5] === '租場地'));
    assert.ok(one.bookings.every((x) => x[4] === '租場地'));
    // 英文
    assert.equal((await req(`/api/admin/report?from=${from}&to=${to}&lang=en`, { auth: token })).data.headers.bookings[0], 'Date');
    // Excel 下載
    const res = await fetch(`${base}/api/admin/report.xlsx?from=${from}&to=${to}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /spreadsheetml/);
    assert.match(res.headers.get('content-disposition'), /filename\*=UTF-8''/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.slice(0, 2).toString(), 'PK');
    // 錯誤與權限
    assert.equal((await req(`/api/admin/report?from=${to}&to=${from}`, { auth: token })).status, 400);
    assert.equal((await req(`/api/admin/report?from=${from}&to=${to}`)).status, 401);
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

describe('註冊、密碼、忘記密碼', () => {
  let req, server, admin;
  const sent = [];
  before(async () => {
    ({ req, server } = await start({ seedSchedule: false, mailer: { enabled: true, send: async (m) => { sent.push(m); } } }));
    admin = (await req('/api/admin/login', { method: 'POST', body: { password: 'secret' } })).data.token;
  });
  after(() => server.close());
  const kid = (name, extra = {}) => ({ name, gender: 'M', birthday: '2016-05-01', ...extra });
  const reg = (body) => req('/api/register', { method: 'POST', body: {
    email: 'new@example.com', password: 'longpass1', consentPrivacy: true, consentPhoto: 'no', ...body } });

  test('新生註冊：必填欄位與同意書', async () => {
    assert.equal((await reg({ students: [kid('小新')], consentPrivacy: false })).status, 400);
    assert.equal((await reg({ students: [kid('小新')], consentPhoto: undefined })).status, 400);
    assert.equal((await reg({ students: [kid('小新')], password: 'short' })).status, 400);
    assert.equal((await reg({ students: [{ name: '小新', birthday: '2016-05-01' }] })).status, 400); // 沒選性別
    assert.equal((await reg({ students: [{ name: '小新', gender: 'F' }] })).status, 400);             // 沒填生日
    const r = await reg({ students: [kid('小新', { healthNotes: '氣喘，請準備吸入器' }), kid('小葵', { gender: 'F', birthday: '2019-01-02' })] });
    assert.equal(r.status, 201);
    assert.deepEqual(r.data.students.map((x) => x.name), ['小新', '小葵']);
    assert.equal((await req('/api/me', { auth: r.data.token })).status, 200); // 註冊後自動登入
    const again = await reg({ students: [kid('小新')] });
    assert.equal(again.status, 409);
    assert.equal(again.data.code, 'EMAIL_EXISTS');

    const list = (await req('/api/admin/students', { auth: admin })).data.students;
    const x = list.find((y) => y.name === '小新');
    assert.equal(x.source, 'self');
    assert.equal(x.gender, 'M');
    assert.equal(x.healthNotes, '氣喘，請準備吸入器');
    assert.equal(x.consentPhoto, 'no');
    assert.ok(x.consentPrivacyAt);
    assert.equal(x.hasPassword, true);
  });

  test('密碼登入、錯誤密碼、變更密碼、幫家人新增學員', async () => {
    assert.equal((await req('/api/login', { method: 'POST', body: { email: 'new@example.com', password: 'wrongpass' } })).status, 401);
    const r = await req('/api/login', { method: 'POST', body: { email: 'NEW@example.com', password: 'longpass1' } });
    assert.equal(r.status, 200);
    const t = r.data.token;
    assert.equal((await req('/api/my/password', { method: 'POST', auth: t, body: { current: 'nope', password: 'newpass12' } })).status, 401);
    assert.equal((await req('/api/my/password', { method: 'POST', auth: t, body: { current: 'longpass1', password: 'newpass12' } })).status, 200);
    assert.equal((await req('/api/login', { method: 'POST', body: { email: 'new@example.com', password: 'newpass12' } })).status, 200);
    const add = await req('/api/my/students', { method: 'POST', auth: t, body: {
      students: [kid('小白')], consentPrivacy: true, consentPhoto: 'yes' } });
    assert.equal(add.status, 201);
    assert.deepEqual(add.data.students.map((x) => x.name), ['小新', '小葵', '小白']);
    assert.equal((await req('/api/my/students', { method: 'POST', auth: t, body: {
      students: [kid('小白')], consentPrivacy: true, consentPhoto: 'yes' } })).status, 409);
  });

  test('舊生沒有密碼 → 忘記密碼寄信 → 設定密碼', async () => {
    const id = (await req('/api/admin/students', { method: 'POST', auth: admin, body: { name: '老學員', email: 'old@example.com' } })).data.id;
    const first = await req('/api/login', { method: 'POST', body: { email: 'old@example.com', password: 'whatever1' } });
    assert.equal(first.status, 409);
    assert.equal(first.data.code, 'NO_PASSWORD');

    sent.length = 0;
    const f = await req('/api/password/forgot', { method: 'POST', body: { email: 'old@example.com' } });
    assert.equal(f.data.sent, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'old@example.com');
    const link = /https?:\/\/\S+\/reset\?token=[\w-]+/.exec(sent[0].text)[0];
    const token = new URL(link).searchParams.get('token');
    // 沒註冊的信箱：回應一樣，但不寄信
    assert.equal((await req('/api/password/forgot', { method: 'POST', body: { email: 'ghost@example.com' } })).data.sent, true);
    assert.equal(sent.length, 1);

    const info = await req(`/api/password/reset?token=${token}`);
    assert.deepEqual(info.data.students, ['老學員']);
    assert.equal((await req('/api/password/reset', { method: 'POST', body: { token, password: 'short' } })).status, 400);
    const done = await req('/api/password/reset', { method: 'POST', body: { token, password: 'oldpass12' } });
    assert.equal(done.status, 200);
    assert.ok(done.data.token);
    // 連結只能用一次
    assert.equal((await req('/api/password/reset', { method: 'POST', body: { token, password: 'another12' } })).status, 410);
    assert.equal((await req('/api/login', { method: 'POST', body: { email: 'old@example.com', password: 'oldpass12' } })).status, 200);

    // 老師產生的連結也可以用，設定後舊的登入會被登出
    const before = (await req('/api/login', { method: 'POST', body: { email: 'old@example.com', password: 'oldpass12' } })).data.token;
    const url = (await req(`/api/admin/students/${id}/reset-link`, { method: 'POST', auth: admin })).data.url;
    await req('/api/password/reset', { method: 'POST', body: { token: new URL(url).searchParams.get('token'), password: 'viaadmin1' } });
    assert.equal((await req('/api/me', { auth: before })).status, 401);
    assert.equal((await req('/api/login', { method: 'POST', body: { email: 'old@example.com', password: 'viaadmin1' } })).status, 200);
  });

  test('後台寄信設定狀態與測試信', async () => {
    const st = await req('/api/admin/mail-status', { auth: admin });
    assert.equal(st.data.enabled, true);
    sent.length = 0;
    assert.equal((await req('/api/admin/mail-test', { method: 'POST', auth: admin, body: { to: 'me@example.com' } })).status, 200);
    assert.equal(sent[0].to, 'me@example.com');
    assert.equal((await req('/api/admin/mail-test', { method: 'POST', body: { to: 'me@example.com' } })).status, 401);
  });

  test('名單顯示身心狀況與攝影同意', async () => {
    const d = today();
    const slot = (await req('/api/admin/slots', { method: 'POST', auth: admin, body: {
      title: '課', date: T.addDays(d, 2), time: '10:00', duration: 60, capacity: 5 } })).data.id;
    const st = (await req('/api/admin/students', { auth: admin })).data.students.find((x) => x.name === '小新');
    await req(`/api/admin/slots/${slot}/bookings`, { method: 'POST', auth: admin, body: { studentId: st.id } });
    const b = (await req(`/api/admin/slots?from=${d}&to=${T.addDays(d, 5)}`, { auth: admin })).data.slots
      .find((x) => x.id === slot).bookings[0];
    assert.equal(b.healthNotes, '氣喘，請準備吸入器');
    assert.equal(b.consentPhoto, 'no');
    assert.equal((await req(`/api/admin/students/${st.id}/photo-consent`, { method: 'POST', auth: admin, body: { value: 'yes' } })).status, 200);
  });
});

test('沒有設定寄信時，忘記密碼請學員聯絡老師', async () => {
  const app = await start({ seedSchedule: false });
  const r = await app.req('/api/password/forgot', { method: 'POST', body: { email: 'a@example.com' } });
  assert.equal(r.data.sent, false);
  app.server.close();
});

test('場地需在開始前 2 小時完成預約', async () => {
  const app = await start({ seedSchedule: false, rentalOpen: '00:00', rentalClose: '24:00' });
  const admin = (await app.req('/api/admin/login', { method: 'POST', body: { password: 'secret' } })).data.token;
  const id = (await app.req('/api/admin/students', { method: 'POST', auth: admin, body: { name: 'A', email: 'a@example.com' } })).data.id;
  const link = (await app.req(`/api/admin/students/${id}/reset-link`, { method: 'POST', auth: admin })).data.url;
  const t = (await app.req('/api/password/reset', { method: 'POST', body: { token: new URL(link).searchParams.get('token'), password: 'pass1234' } })).data.token;
  // 現在起 1 小時內的下一個半點 → 不到 2 小時，不能訂
  const nowMs = T.toMs(T.nowLocal(TZ));
  const soon = T.fromMs(Math.ceil((nowMs + 31 * 60000) / 1800000) * 1800000);
  if (soon.slice(11) <= '22:30') {
    const r = await app.req('/api/rentals', { method: 'POST', auth: t, body: { type: 'self', date: soon.slice(0, 10), start: soon.slice(11), hours: 1 } });
    assert.equal(r.status, 409);
    assert.match(r.data.error, /2 小時/);
    const seg = (await app.req(`/api/rentals/availability?date=${soon.slice(0, 10)}`)).data.segments.find((x) => x.time === soon.slice(11));
    assert.equal(seg.closed, true);
    // 後台代訂不受限制
    assert.equal((await app.req('/api/admin/rentals', { method: 'POST', auth: admin, body: {
      contactName: 'B', type: 'self', date: soon.slice(0, 10), start: soon.slice(11), hours: 1 } })).status, 201);
  }
  app.server.close();
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

test('舊版（信箱不可重複）學員表升級後可共用信箱，資料與預約保留', () => {
  const { DatabaseSync } = require('node:sqlite');
  const { openDb, createStore } = require('../lib/db');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bk-')), 'old3.db');
  const old = new DatabaseSync(file);
  old.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE slots (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, start_at TEXT NOT NULL,
      duration_min INTEGER NOT NULL, capacity INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE students (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      phone TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login TEXT);
    CREATE TABLE bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, slot_id INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE, note TEXT NOT NULL DEFAULT '',
      trial INTEGER NOT NULL DEFAULT 0, booked_by TEXT NOT NULL DEFAULT 'student', status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')), cancelled_at TEXT);
    INSERT INTO slots (title, start_at, duration_min, capacity) VALUES ('課', '2030-01-01T10:00', 60, 5);
    INSERT INTO students (id, name, email) VALUES (7, '哥哥', 'fam@example.com');
    INSERT INTO bookings (slot_id, student_id) VALUES (1, 7);`);
  old.close();
  const db = openDb(file);
  const st = createStore(db);
  assert.equal(st.getStudent(7).name, '哥哥');
  assert.equal(st.getSlot(1).booked, 1);
  st.createStudent({ name: '妹妹', email: 'FAM@example.com', phone: '', note: '' });
  assert.deepEqual(st.studentsByEmail('fam@example.com').map((x) => x.name), ['哥哥', '妹妹']);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  db.close();
});

test('時間工具', () => {
  assert.equal(T.isValidDate('2026-02-30'), false);
  assert.equal(T.isValidDate('2026-02-28'), true);
  assert.equal(T.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(T.weekday('2026-11-22'), 0);
});
