# dsh-bili-video-kit

把「[dsh-video-storyboard](https://github.com/SAOS-3624/dsh-video-storyboard)」和「B 站接入」拼在一起的一套说明和脚本。

故事板插件本身负责**把一条视频切成能读的分镜 + 台词**；它不负责登录 B 站，也不负责取 UP 主的投稿、简介、评论。这份仓库补的就是那两头：**喂给它一条 B 站的片子**，以及**让它的耳朵（转录）真的能响**。

> 这份东西不打包、不重发上游的代码。插件请从上游仓库装，这里只给用法、配置和几个独立脚本。

---

## 这套东西长什么样

```
┌─────────────┐   视频链接/文件     ┌──────────────────────┐
│ B 站取数     │ ───────────────▶  │ dsh-video-storyboard │
│ 脚本 + 接口  │                    │  probe / storyboard  │
└─────────────┘                    │  zoom / locate       │
        │                          │  subtitles           │
        │ cookie                    └──────────┬───────────┘
        ▼                                      │ 要台词
   ~/.dsh/.../cookies/                         ▼
                                        ┌──────────────┐
                                        │ 本机 ASR 服务 │
                                        │ SenseVoice   │
                                        │ 离线、不要 key│
                                        └──────────────┘
```

三条线互不依赖，坏哪条修哪条：

| 线 | 目录 | 你需要什么 |
|---|---|---|
| **B 站登录态** | `scripts/bili-cookie.mjs`、`scripts/bili-auth.mjs` | 自己扫码留下的 cookie 文件 |
| **B 站取数** | `scripts/bili-up.mjs`、`scripts/bili-search.mjs` | 同上；官方 web 接口 |
| **看内容** | 上游插件 + `scripts/asr-server.cjs` | Node、ffmpeg、SenseVoice 模型 |

---

## 快速开始

### 0. 前置

- Windows（这份说明在 Win11 上验证；脚本本身是跨平台的 Node）
- Node.js 18+（用的是全局 `fetch`，所以不能太老）
- ffmpeg / ffprobe（抽帧、切音频都要）
- SenseVoice ONNX 模型（约 228 MB，离线）

### 1. 装插件（上游）

到 [SAOS-3624/dsh-video-storyboard](https://github.com/SAOS-3624/dsh-video-storyboard) 按它的说明装进 DSH。装完确认这几个工具在：`video_probe`、`video_storyboard`、`video_zoom`、`video_locate`、`video_subtitles`。

### 2. 放 cookie

```
~/.dsh/worlds/default/room/cookies/
  bilibili-login.txt     ← 必需，扫码登录后导出（Netscape 格式）
  bilibili.txt           ← 可选，早一份，只借它的匿名设备号
```

用别的目录也行，设环境变量 `BILI_COOKIE_DIR` 指过去。

### 3. 查登录态

```bash
node scripts/bili-auth.mjs
# 登录着：<昵称>  mid=<数字>
```

退出码：`0` 登着、`1` 掉了（只有这种要重新扫码）、`2` 不确定（风控/网络，别当成掉了）。

### 4. 起本机 ASR

```bash
node scripts/asr-server.cjs
# 另一个终端：curl http://127.0.0.1:8123/health
```

再让插件认得它——写到 `~/.dsh/asr.json`：

```json
{
  "baseUrl": "http://127.0.0.1:8123/v1",
  "model": "sensevoice-onnx",
  "language": "zh",
  "manage": {
    "start": ["node", "<绝对路径>/scripts/asr-server.cjs"],
    "idleMs": 60000, "waitMs": 60000, "healthPath": "/health"
  }
}
```

本机地址**不需要 key**。配好以后插件会自己拉起这个服务，空闲一分钟自己退。

### 5. 看一条片子

```
video_probe      → 先知道多长、有没有音轨/字幕轨
video_storyboard → 分镜拼图 + 台词索引，长片按窗口（from + segment）跟着 next 读
video_zoom       → 某一格的字太小，单独放大重读
video_locate     → 记得某句话、忘了在第几分钟
video_subtitles  → 只有烧进画面的字幕、ASR 又认不出时，切字幕带拼成一竖条
```

细节在 [docs/03-看片流水线.md](docs/03-看片流水线.md)。

---

## 目录

```
scripts/
  bili-cookie.mjs     两份 cookie 合成一份请求头（认证字段优先新文件）
  bili-auth.mjs       查登录态，退出码有语义
  bili-up.mjs         某个 UP 主最近发了什么（空间接口 → 风控时退搜索接口）
  bili-search.mjs     关键词搜索（带 wbi 签名）
  asr-server.cjs      本机 OpenAI 兼容转写服务（SenseVoice，离线）
  asr.example.json    ~/.dsh/asr.json 的模板
docs/
  01-装故事板插件.md
  02-B站登录与取数.md
  03-看片流水线.md
  04-排错.md
  05-发言与@提醒.md
```

---

## 边界

- 只读：不点赞、不评论、不关注、不发私信，也不改账号任何状态
- cookie 只由本人扫码产生，脚本从不代为登录，也不会写回文件
- 解出来的画面、字幕、评论只自用；别把别人的作品搬去公开渠道

## 致谢与许可

- 分镜/转录插件是 [SAOS-3624](https://github.com/SAOS-3624/dsh-video-storyboard) 的项目，本仓库不包含它的代码，许可以上游仓库为准
- 语音识别用的是 [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) 的 ONNX 版本，经 sherpa-onnx 调用
- 本仓库的脚本随意取用
