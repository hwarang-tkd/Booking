'use strict';
// 場地租借：類型、收費、同時段上限與空檔計算（依花郎武道館收費表）。

const RENTAL_TYPES = {
  // 團體課程：包場，同時段只能有這一組，也不能和一對一／自主訓練同時
  group: { name: '團體課程', nameEn: 'Group class', rate: 600, per: 'hour', exclusive: true, cap: 1 },
  // 一對一：同一時段最多三組
  private: { name: '一對一', nameEn: 'One-on-one', rate: 200, per: 'hour', exclusive: false, cap: 3 },
  // 自主訓練：每人每小時 100 元，同一時段最多 6 人
  self: { name: '自主訓練', nameEn: 'Self-training', rate: 100, per: 'person-hour', exclusive: false, cap: 6 },
};
const STEP = 30; // 以 30 分鐘為單位

const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const toTime = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** 費用：團體、一對一按小時；自主訓練按人頭×小時。 */
function rentalPrice(type, minutes, people = 1) {
  const t = RENTAL_TYPES[type];
  const hours = minutes / 60;
  return Math.round(t.rate * hours * (t.per === 'person-hour' ? people : 1));
}

/**
 * 計算某天每 30 分鐘的使用狀況。
 * slots：當天的課程（start_at、duration_min、cancelled）
 * rentals：當天有效的租借（start、end、type、people）
 */
function daySegments({ open, close, slots, rentals }) {
  const segs = [];
  for (let m = toMin(open); m < toMin(close); m += STEP) {
    const s = { time: toTime(m), start: m, end: m + STEP, classBusy: false, group: 0, private: 0, self: 0 };
    for (const c of slots) {
      if (c.cancelled) continue;
      const cs = toMin(c.start_at.slice(11)), ce = cs + c.duration_min;
      if (cs < s.end && s.start < ce) s.classBusy = true;
    }
    for (const r of rentals) {
      if (toMin(r.start) < s.end && s.start < toMin(r.end)) {
        if (r.type === 'self') s.self += r.people; else s[r.type] += 1;
      }
    }
    segs.push(s);
  }
  return segs;
}

/** 這個時段能不能再租這種類型；不行時回傳原因。 */
function checkSegment(seg, type, people = 1) {
  if (seg.classBusy) return '這個時段有課程，不能租借';
  if (seg.group > 0) return '這個時段已經被包場租借';
  if (type === 'group') {
    if (seg.private > 0 || seg.self > 0) return '這個時段已經有人租借（一對一或自主訓練），不能包場';
    return null;
  }
  if (type === 'private' && seg.private + 1 > RENTAL_TYPES.private.cap) return '這個時段的一對一已經滿 3 組';
  if (type === 'self' && seg.self + people > RENTAL_TYPES.self.cap) {
    const left = RENTAL_TYPES.self.cap - seg.self;
    return left > 0 ? `這個時段的自主訓練只剩 ${left} 個名額` : '這個時段的自主訓練已經滿 6 人';
  }
  return null;
}

module.exports = { RENTAL_TYPES, STEP, toMin, toTime, rentalPrice, daySegments, checkSegment };
