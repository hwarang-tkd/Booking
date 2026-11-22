'use strict';
// 課程分類（顏色對應花郎武道館課表海報）與預設的每週固定課表。

const CATEGORIES = [
  { id: 'tkd', name: '跆拳道（12歲以上）', color: '#9fb3d4' },
  { id: 'kids', name: '兒童跆拳道', color: '#c6d87c' },
  { id: 'little', name: '幼兒期班（3–6歲）', color: '#fbefbf' },
  { id: 'combat', name: '格鬥', color: '#b9a5cf' },
  { id: 'blackbelt', name: '黑帶訓練', color: '#f2625e' },
  { id: 'private', name: '私人課', color: '#b3b3b3' },
  { id: 'other', name: '其他', color: '#e3d3d4' },
];
const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

// weekday：0 = 週日、1 = 週一 … 6 = 週六
const t = (weekday, time, duration, title, subtitle, category, capacity, note = '') =>
  ({ weekday, time, duration, title, subtitle, category, capacity, note });

const DEFAULT_TEMPLATES = [
  t(1, '10:30', 90, '跆拳道', 'Taekwon-Do・12歲以上', 'tkd', 20),
  t(1, '19:30', 90, '格鬥女子班', 'Girls Combat・12歲以上', 'combat', 20),
  t(2, '19:30', 90, '跆拳道', 'Taekwon-Do・12歲以上', 'tkd', 20),
  t(3, '19:30', 90, '格鬥訓練', 'Combat Conditioning・12歲以上', 'combat', 20),
  t(4, '19:30', 90, '跆拳道', 'Taekwon-Do・12歲以上', 'tkd', 20),
  t(5, '10:30', 90, '跆拳道', 'Taekwon-Do・12歲以上', 'tkd', 20),
  t(5, '12:30', 60, '私人培訓課程', 'Private Session', 'private', 1, '一對一私人課'),
  t(6, '10:30', 90, '兒童跆拳道（進階班）', 'Taekwon-Do Kids・進階班', 'kids', 20),
  t(6, '13:00', 60, '幼兒跆拳期班', 'ITF Kids Program・3至6歲', 'little', 15),
  t(6, '14:00', 90, '兒童跆拳道', 'Taekwon-Do Kids', 'kids', 20),
  t(6, '16:00', 90, '跆拳道', 'Taekwon-Do・12歲以上', 'tkd', 20),
  t(6, '18:00', 90, '黑帶訓練（紅帶以上）', 'Black Belt Training', 'blackbelt', 20),
  t(0, '10:30', 90, '兒童跆拳道', 'Taekwon-Do Kids・8至12歲', 'kids', 20),
  t(0, '13:00', 60, '幼兒跆拳期班', 'ITF Kids Program・3至6歲', 'little', 15),
  t(0, '14:00', 90, '兒童跆拳道', 'Taekwon-Do Kids', 'kids', 20),
  t(0, '16:00', 90, '跆拳道', 'Taekwon-Do・12歲以上', 'tkd', 20),
];

module.exports = { CATEGORIES, CATEGORY_IDS, DEFAULT_TEMPLATES };
