import crypto from "node:crypto";
// cookie 从 bili-cookie.mjs 拿：认证字段用 11-13 那份新的，设备号缺了才从旧文件补。
import { loadCookie, headers } from "./bili-cookie.mjs";

const H = headers(loadCookie());

const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];

async function getWbiKeys() {
  const r = await fetch("https://api.bilibili.com/x/web-interface/nav", { headers: H });
  const j = await r.json();
  const imgUrl = j.data.wbi_img.img_url;
  const subUrl = j.data.wbi_img.sub_url;
  return {
    imgKey: imgUrl.slice(imgUrl.lastIndexOf("/") + 1, imgUrl.lastIndexOf(".")),
    subKey: subUrl.slice(subUrl.lastIndexOf("/") + 1, subUrl.lastIndexOf(".")),
  };
}

function mixinKey(imgKey, subKey) {
  const raw = imgKey + subKey;
  return MIXIN_TAB.map((i) => raw[i]).join("").slice(0, 32);
}

async function wbiQuery(params) {
  const { imgKey, subKey } = await getWbiKeys();
  const mk = mixinKey(imgKey, subKey);
  const wts = Math.floor(Date.now() / 1000);
  const all = { ...params, wts };
  const query = Object.keys(all).sort().map((k) => {
    const v = String(all[k]).replace(/[!'()*]/g, "");
    return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
  }).join("&");
  const w_rid = crypto.createHash("md5").update(query + mk).digest("hex");
  return `${query}&w_rid=${w_rid}`;
}

const kw = process.argv[2] || "三角洲行动";
const q = await wbiQuery({ search_type: "video", keyword: kw, page: 1, page_size: 20 });
const r = await fetch(`https://api.bilibili.com/x/web-interface/wbi/search/type?${q}`, {
  headers: { ...H, "Origin": "https://search.bilibili.com", "Referer": `https://search.bilibili.com/all?keyword=${encodeURIComponent(kw)}` },
});
const j = await r.json();
if (j.code !== 0) { console.log("code", j.code, j.message); process.exit(1); }
for (const v of (j.data.result || [])) {
  console.log(`${v.bvid} | ${v.title.replace(/<[^>]+>/g, "")} | 播放 ${v.play} | ${v.duration} | ${v.author}`);
}
