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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 空间投稿接口被风控（-403 / -352）时的退路：
// 用搜索接口按发布日期排，再按 author 精确筛回这个号。
async function latestViaSearch(author, ps = 6) {
  const out = [];
  const seen = new Set();
  for (const page of [1, 2, 3, 4, 5]) {
    const q = `search_type=video&order=pubdate&keyword=${encodeURIComponent(author)}&page=${page}`;
    const r = await fetch(`https://api.bilibili.com/x/web-interface/wbi/search/type?${q}`, {
      headers: { ...H, Referer: "https://search.bilibili.com/" },
    });
    const j = await r.json();
    if (j.code !== 0) { console.log(`  [搜索接口] page${page} -> code ${j.code} ${j.message}`); break; }
    for (const v of j.data?.result || []) {
      if (v.author !== author) continue;
      if (seen.has(v.bvid)) continue;
      seen.add(v.bvid);
      out.push({
        bvid: v.bvid,
        title: (v.title || "").replace(/<[^>]+>/g, ""),
        created: v.pubdate ? new Date(v.pubdate * 1000).toISOString().slice(0, 16).replace("T", " ") : "?",
        play: v.play,
        length: v.duration,
      });
    }
    if (out.length >= ps) break;
    await sleep(1500);
  }
  return out.slice(0, ps);
}

async function latestVideos(mid, ps = 6, author = "") {
  const q = await wbiQuery({
    mid, ps, pn: 1, order: "pubdate", platform: "web", web_location: 1550101,
    tid: 0, keyword: "", index: 0,
    dm_img_list: "[]",
    dm_img_str: "V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ",
    dm_cover_img_str: "QU5HTEUgKEludGVsLCBJbnRlbChSKSBVSEQgR3JhcGhpY3MgNjMwKSBEaXJlY3QzRDExIHZzXzVfMCBwc181XzAsIHByb2dyYW0p",
    dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
  });
  const r = await fetch(`https://api.bilibili.com/x/space/wbi/arc/search?${q}`, {
    headers: {
      ...H,
      "Origin": "https://space.bilibili.com",
      "Referer": `https://space.bilibili.com/${mid}/video`,
    },
  });
  const j = await r.json();
  if (j.code !== 0) {
    console.log(`  空间接口挡了（code ${j.code} ${j.message}），改走搜索`);
    return author ? await latestViaSearch(author, ps) : [];
  }
  return (j.data.list.vlist || []).map((v) => ({
    bvid: v.bvid,
    title: v.title,
    created: v.created ? new Date(v.created * 1000).toISOString().slice(0, 16).replace("T", " ") : "?",
    play: v.play,
    length: v.length,
  }));
}

for (const [name, mid] of [["梗百科", 1544008396], ["梗指南", 94510621]]) {
  const list = await latestVideos(mid, 6, name);
  console.log(`\n### ${name} 最新 ${list.length} 条`);
  for (const v of list) console.log(`- ${v.created} | ${v.title} | ${v.bvid} | 播放 ${v.play} | ${v.length}`);
  await sleep(2000);
}
