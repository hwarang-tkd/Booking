'use strict';
// 寄信：使用 Resend（https://resend.com）的 HTTP API。
// Railway 的 Hobby 方案不能直接用 SMTP 寄信，所以用 HTTPS API。
// 沒有設定 RESEND_API_KEY 時不寄信，重設密碼連結改由老師在後台產生後用 LINE 等方式傳給學員。

function createMailer({ apiKey, from }) {
  if (!apiKey || !from) {
    return { enabled: false, send: async () => { throw new Error('mail not configured'); } };
  }
  return {
    enabled: true,
    async send({ to, subject, text, html }) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text, html }),
      });
      if (!res.ok) {
        const raw = await res.text();
        let detail = raw;
        try { detail = JSON.parse(raw).message || raw; } catch { /* 不是 JSON 就用原文 */ }
        throw new Error(`Resend ${res.status}: ${String(detail).slice(0, 300)}`);
      }
    },
  };
}

const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 重設密碼信（中英雙語）。 */
function resetPasswordMail({ school, schoolEn, names, link, hours }) {
  const who = names.join('、');
  const text = [
    `${who} 您好：`,
    '',
    `請點下面的連結設定 ${school} 約課網站的密碼（${hours} 小時內有效）：`,
    link,
    '',
    '如果您沒有申請重設密碼，請忽略這封信。',
    '',
    '---',
    `Hello ${who},`,
    `Use the link below to set your password for ${schoolEn} class booking (valid for ${hours} hours):`,
    link,
    "If you didn't request this, you can ignore this email.",
  ].join('\n');
  const html = `<div style="font-family:system-ui,sans-serif;line-height:1.6;color:#222">
    <p>${escHtml(who)} 您好：</p>
    <p>請點下面的按鈕設定 ${escHtml(school)} 約課網站的密碼（${hours} 小時內有效）：</p>
    <p><a href="${escHtml(link)}" style="display:inline-block;background:#231c1e;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none">設定密碼 Set password</a></p>
    <p style="color:#777;font-size:13px">如果按鈕無法點選，請複製這個網址：<br>${escHtml(link)}</p>
    <p style="color:#777;font-size:13px">如果您沒有申請重設密碼，請忽略這封信。<br>If you didn't request this, you can ignore this email.</p>
  </div>`;
  return { subject: `${school}｜設定密碼 Set your password`, text, html };
}

module.exports = { createMailer, resetPasswordMail };
