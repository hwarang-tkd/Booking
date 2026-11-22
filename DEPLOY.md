# 上線步驟：Railway + WordPress.com 網域

完成後：

| 用途 | 網址 |
| --- | --- |
| 官網（不變） | https://hwarang-tkd-tw.com |
| 學生約課 | https://booking.hwarang-tkd-tw.com |
| 老師後台 | https://booking.hwarang-tkd-tw.com/admin |

WordPress.com 主機不能跑這個系統（它只跑 WordPress），所以約課系統放在 Railway，
再用子網域 `booking` 接到你的網域。官網完全不受影響。

---

## 一、把約課系統架到 Railway（約 10 分鐘）

1. 到 <https://railway.com> 用 **GitHub 帳號**登入，選付費方案 Hobby（每月約 5 美元）。
2. **New Project → Deploy from GitHub repo**，授權後選 `hwarang-tkd/Booking`。
   - 如果 repo 裡沒有 `main` 分支，到服務的 **Settings → Source → Branch** 選要部署的分支。
3. 點進服務 → **Variables**，新增：

   | 名稱 | 值 |
   | --- | --- |
   | `ADMIN_PASSWORD` | 你的後台密碼 |
   | `PORT` | `3000` |
   | `FACEBOOK_URL` | （選填）粉絲專頁網址 |

4. **新增永久儲存空間（一定要做，否則重新部署後資料會消失）**
   在專案畫面按 **Create → Volume**（或在服務上按右鍵 → Attach Volume），
   掛到這個服務，**Mount path 填 `/data`**。
5. 等部署完成（狀態變成 Active）。到 **Settings → Networking → Generate Domain**，
   會得到一個 `xxx.up.railway.app` 的測試網址，打開確認看得到課表、`/admin` 可以登入。

## 二、接上自己的網域

6. 同一頁 **Settings → Networking → Custom Domain**，輸入
   `booking.hwarang-tkd-tw.com`，Port 選 `3000`。
   Railway 會顯示要新增的 DNS 記錄（一筆 **CNAME**，有時另外一筆 **TXT** 驗證），先不要關掉這頁。
7. 另開分頁到 **WordPress.com**：
   **我的首頁 → 升級（Upgrades）→ 網域（Domains）→ 點 `hwarang-tkd-tw.com` → DNS 記錄（DNS records）→ 新增記錄（Add a record）**

   | 類型 | 名稱 / 主機 | 值（別名 / Alias of） |
   | --- | --- | --- |
   | CNAME | `booking` | Railway 顯示的值（例如 `abc123.up.railway.app`） |
   | TXT（如果 Railway 有要求） | Railway 顯示的名稱 | Railway 顯示的值 |

   名稱只要填 `booking`，WordPress.com 會自動接上 `.hwarang-tkd-tw.com`。
8. 回到 Railway，等網域旁邊出現綠色勾勾（通常幾分鐘，最久可能 1–2 天）。
   HTTPS 憑證會自動申請，不用另外設定。

## 三、在官網放入口

9. WordPress.com 後台 → **外觀 → 編輯器 → 導覽（Navigation）**，新增「自訂連結」：
   - 文字：`線上約課`
   - 網址：`https://booking.hwarang-tkd-tw.com`

   也可以在首頁放一個按鈕連過去。**建議用連結，不要用 iframe 嵌入**（iPhone 會擋掉嵌入頁面的登入狀態）。

## 四、開始使用

10. 打開 `https://booking.hwarang-tkd-tw.com/admin` 登入。
11. **學員資料 → 批次匯入**，貼上學員名單（姓名、信箱、電話）。
12. **固定課表**：確認每堂課的名額。
13. 把 `https://booking.hwarang-tkd-tw.com` 傳給學員，請他們用登記的信箱登入。

---

## 五、設定寄信（忘記密碼用，選用）

沒設定也能運作：學員按「忘記密碼」時會請他聯絡老師，老師在後台「學員資料 → 密碼連結」產生連結，用 LINE 傳給學員即可。
想讓學員自己收信設定密碼：

1. 到 <https://resend.com> 免費註冊（每月 3,000 封）。
2. **Domains → Add Domain**，輸入 `hwarang-tkd-tw.com`，Resend 會列出幾筆 DNS 記錄（TXT／MX）。
3. 到 WordPress.com 的 DNS 記錄，照 Resend 顯示的內容逐筆新增，回 Resend 按 Verify。
4. Resend → **API Keys → Create API Key**，複製下來。
5. Railway → Variables 新增：

   | 名稱 | 值 |
   | --- | --- |
   | `RESEND_API_KEY` | 剛剛複製的 key |
   | `MAIL_FROM` | `花郎武道館 <no-reply@hwarang-tkd-tw.com>` |
   | `PUBLIC_URL` | `https://booking.hwarang-tkd-tw.com` |

（Railway Hobby 方案不能用 SMTP 寄信，所以這裡用 Resend 的 HTTPS API。）

## 日常維護

- **程式更新**：推到 GitHub 的部署分支，Railway 會自動重新部署，資料保留在 Volume 裡。
- **備份**：Railway 的 Volume 頁面可以開啟定期備份（Backups）。
- **改密碼**：Railway → Variables 修改 `ADMIN_PASSWORD`，會自動重新啟動。
- **注意**：這個系統用 SQLite 存資料，Railway 服務請維持 **1 個執行個體**（預設就是），不要開多個副本。
