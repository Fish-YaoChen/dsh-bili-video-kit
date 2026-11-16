import fs from "node:fs";
import path from "node:path";

// B 站 cookie 的两份文件，各管一段：
//   bilibili-login.txt  扫码登录后保存的那份，认证字段（SESSDATA / bili_jct / DedeUserID）只认它
//   bilibili.txt        更早的一份，认证多半已经过期（-101），但里面的匿名设备号
//                       （buvid3 / buvid4 / _uuid）还能补上
// 所以：认证字段以新文件为准，设备号缺了才从旧文件补，同名一律不覆盖。
//
// cookie 放哪：环境变量 BILI_COOKIE_DIR 指到那个文件夹，
// 不设就用默认的 ~/.dsh/worlds/default/room/cookies
const COOKIE_DIR = process.env.BILI_COOKIE_DIR
  || path.join(process.env.USERPROFILE || process.env.HOME || ".", ".dsh", "worlds", "default", "room", "cookies");
export const LOGIN_FILE = path.join(COOKIE_DIR, "bilibili-login.txt");
export const OLD_FILE = path.join(COOKIE_DIR, "bilibili.txt");

export const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36";

// 想带上的都在这里；不在表里的（theme-tip-show 之类）不往请求头里塞。
const WANT = new Set([
  "SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid",
  "buvid3", "buvid4", "_uuid", "b_nut", "bili_ticket", "bili_ticket_expires",
]);

// Netscape cookie 文件：域名 \t 包含子域 \t 路径 \t 仅 HTTPS \t 过期 \t 名 \t 值
export function parseCookieFile(file) {
  const out = [];
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const p = line.split("\t");
    if (p.length < 7) continue;
    const name = p[5].replace(/^#HttpOnly_/, "");
    if (!WANT.has(name)) continue;
    out.push([name, p[6].replace(/[\r\n]/g, "")]);
  }
  return out;
}

// files 按优先级给：前面的同名值赢。传一个文件就只用那一个（测「掉了」就是这么测）。
export function loadCookie(files = [LOGIN_FILE, OLD_FILE]) {
  const jar = new Map();
  for (const file of files) {
    for (const [name, value] of parseCookieFile(file)) {
      if (!jar.has(name)) jar.set(name, value);
    }
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

export function headers(cookie) {
  return { "User-Agent": UA, Cookie: cookie, Referer: "https://www.bilibili.com/" };
}
