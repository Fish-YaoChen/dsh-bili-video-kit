// B 站登录态还在不在——一条命令，一行结果。
//
//   node bili-auth.mjs                        # 用 cookies\bilibili-login.txt（+ 旧文件补设备号）
//   node bili-auth.mjs --cookie <某个文件>    # 只用这一份（测「掉了」就是这么测）
//
// 退出码：
//   0  登录着
//   1  掉了（-101 账号未登录）——只有这种需要重新扫码
//   2  不确定：网络不通 / 其它 code（风控 -352、-403 之类），别当成掉了
//
// 只读。不改 cookie、不登录、不写任何文件。
import { LOGIN_FILE, loadCookie, headers } from "./bili-cookie.mjs";

const argv = process.argv.slice(2);
let cookieFile = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--cookie") cookieFile = argv[++i];
  else if (argv[i].startsWith("--cookie=")) cookieFile = argv[i].slice("--cookie=".length);
}

const cookie = cookieFile ? loadCookie([cookieFile]) : loadCookie();
if (!cookie) {
  console.log(`不确定：没有可用的 cookie（${cookieFile || LOGIN_FILE}）`);
  process.exit(2);
}

let nav;
try {
  const r = await fetch("https://api.bilibili.com/x/web-interface/nav", {
    headers: headers(cookie),
    signal: AbortSignal.timeout(20000),
  });
  nav = await r.json();
} catch (e) {
  console.log(`不确定：请求没出去或没回来（${e.name}: ${e.message}）——这不是掉了`);
  process.exit(2);
}

const d = nav.data || {};
if (nav.code === 0 && d.isLogin) {
  console.log(`登录着：${d.uname}  mid=${d.mid}`);
  process.exit(0);
}
if (nav.code === -101) {
  console.log(`掉了：-101 ${nav.message || "账号未登录"}（该重新扫码了）`);
  process.exit(1);
}
console.log(`不确定：code=${nav.code} ${nav.message || ""}（不是 -101，先别急着重新扫码）`);
process.exit(2);
