// asr-server.cjs —— 本机 OpenAI 兼容的转写服务（SenseVoice，不联网、不要 key）
//
// 为什么要它：dsh-video-storyboard 的转录层只认两样东西 —— 宿主的 speechToText 服务，
// 或者一个 OpenAI 兼容的 /audio/transcriptions 端点。这台机器前者没注册上，后者又没配，
// 所以它一直报 no-key。模型、sherpa、ffmpeg 全在本机，缺的只是一个端点。
//
// 用法：
//   node room\tools\asr-server.cjs
//   然后 ~\.dsh\asr.json 里 baseUrl 指 http://127.0.0.1:8123/v1
//
// 端点：
//   GET  /health                        → {"ok":true}
//   POST /v1/audio/transcriptions       → verbose_json（text + segments）
//   POST /shutdown                      → 让本服务自己退出（插件空闲时会发）
//
// 契约要点（照 docs/asr-contract.md）：
//   - segments 的 start/end 必须**相对本次上传**，从 0 起
//   - 没有 segments 会被插件退化成一整块，所以这里一定给
//   - 出错要真回非 2xx，并带一句人话

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// 三个路径都能用环境变量换掉，默认值只是常见安装位置：
//   ASR_NODE_MODULES  sherpa-onnx-node 所在的 node_modules
//   ASR_MODEL_DIR     SenseVoice onnx 模型目录（里面有 model.int8.onnx 和 tokens.txt）
//   ASR_LOG_DIR       日志目录，默认系统临时目录
const os0 = require('node:os');
const NM = process.env.ASR_NODE_MODULES
  || 'E:\\DSH NEXT\\resources\\app.asar.unpacked\\node_modules';
const MODEL_DIR = process.env.ASR_MODEL_DIR
  || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'speech-to-text', 'sensevoice', 'models', 'sensevoice-onnx');
const HOST = '127.0.0.1';
const PORT = Number(process.env.ASR_PORT || 8123);
const IDLE_MS = Number(process.env.ASR_IDLE_MS || 60000);
const MAX_BODY = 300 * 1024 * 1024;
const LOG = path.join(process.env.ASR_LOG_DIR || os0.tmpdir(), 'asr-server.log');

let recognizer = null;
let idleTimer = null;

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch { /* 日志写不进去不影响转写 */ }
  console.log(line);
}

function touch() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    log('idle', IDLE_MS, 'ms，自己退出');
    process.exit(0);
  }, IDLE_MS);
}

function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
  });
  res.end(body);
}

/** 把 WAV 拆成 Float32Array 的样本。只认 16 bit 单声道 PCM。 */
function wavToSamples(buf) {
  if (buf.length < 44) throw new Error('wav 太短，不是 WAV');
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('不是 RIFF/WAVE');
  }
  let fmt = null;
  let data = null;
  for (let p = 12; p + 8 <= buf.length;) {
    const id = buf.toString('latin1', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    const body = p + 8;
    if (id === 'fmt ') fmt = buf.subarray(body, body + Math.max(size, 16));
    if (id === 'data') {
      const end = size === 0xFFFFFFFF ? buf.length : Math.min(buf.length, body + size);
      data = buf.subarray(body, end);
      break;
    }
    if (size === 0xFFFFFFFF || body + size > buf.length) break;
    p = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV 缺 fmt 或 data 块');
  const audioFormat = fmt.readUInt16LE(0);
  const channels = fmt.readUInt16LE(2);
  const sampleRate = fmt.readUInt32LE(4);
  const bits = fmt.readUInt16LE(14);
  if (audioFormat !== 1) throw new Error(`只吃 PCM（拿到了 format=${audioFormat}）`);
  if (bits !== 16) throw new Error(`只吃 16 bit（拿到了 ${bits}）`);
  if (channels !== 1) throw new Error(`只吃单声道（拿到了 ${channels} 声道）`);
  const n = data.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = data.readInt16LE(i * 2) / 32768;
  return { samples: out, sampleRate, seconds: n / sampleRate };
}

function ensureRecognizer() {
  if (recognizer) return recognizer;
  const t0 = Date.now();
  const { OfflineRecognizer } = require(`${NM}\\sherpa-onnx-node\\non-streaming-asr.js`);
  recognizer = new OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: `${MODEL_DIR}\\model.int8.onnx`,
        language: 'zh',
        useInverseTextNormalization: 1,
      },
      tokens: `${MODEL_DIR}\\tokens.txt`,
      numThreads: 4,
      provider: 'cpu',
      debug: 0,
    },
  });
  log('recognizer ready in', Date.now() - t0, 'ms');
  return recognizer;
}

/** 把字符位置吸到最近的标点后面，免得一句话被切成两半 */
function snapForward(text, pos) {
  const BREAKS = '。！？；，';
  const lo = Math.max(0, pos - 10);
  const hi = Math.min(text.length, pos + 10);
  let best = -1;
  let bestD = Infinity;
  for (let i = lo; i < hi; i += 1) {
    if (!BREAKS.includes(text[i])) continue;
    const cand = i + 1;
    const d = Math.abs(cand - pos);
    if (d < bestD) { best = cand; bestD = d; }
  }
  return best === -1 ? pos : best;
}

/**
 * 把 token 时间戳切成句子。
 * 断句：相邻 token 间隔 > GAP，或一段已经超过 MAX_LEN 秒。
 * 文本按 token 序号在整段文字里的占比切，这样标点、语气词都留在原文里。
 */
function buildSegments(result, totalSeconds) {
  const tokens = result.tokens || [];
  const ts = result.timestamps || [];
  const text = result.text || '';
  if (!text) return [];
  if (!tokens.length || tokens.length !== ts.length) {
    return [{ start: 0, end: Math.max(0.2, totalSeconds), text }];
  }

  const GAP = 0.6;
  const MAX_LEN = 12;
  const ranges = [];
  let i0 = 0;
  for (let i = 1; i < ts.length; i += 1) {
    const gap = ts[i] - ts[i - 1];
    const span = ts[i] - ts[i0];
    if (gap > GAP || span > MAX_LEN) {
      ranges.push([i0, i]);
      i0 = i;
    }
  }
  ranges.push([i0, ts.length]);

  const out = [];
  let cursor = 0;
  for (const [a, b] of ranges) {
    const approx = Math.round((text.length * b) / ts.length);
    const stop = b >= ts.length ? text.length : snapForward(text, approx);
    if (stop <= cursor) continue;
    const piece = text.slice(cursor, stop).trim();
    cursor = stop;
    if (!piece) continue;
    const start = ts[a];
    const rawEnd = b < ts.length ? ts[b] : totalSeconds;
    out.push({
      start: Number(start.toFixed(2)),
      end: Number(Math.max(rawEnd, start + 0.2).toFixed(2)),
      text: piece,
    });
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error(`请求体超过 ${MAX_BODY} 字节`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipart(body, boundary) {
  const delim = Buffer.from(`--${boundary}`);
  const parts = [];
  let pos = body.indexOf(delim);
  while (pos !== -1) {
    let p = pos + delim.length;
    if (body[p] === 45 && body[p + 1] === 45) break; // 结束的 "--"
    if (body[p] === 13 && body[p + 1] === 10) p += 2;
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), p);
    if (headerEnd === -1) break;
    const headers = body.subarray(p, headerEnd).toString('utf8');
    const dataStart = headerEnd + 4;
    const next = body.indexOf(delim, dataStart);
    if (next === -1) break;
    let dataEnd = next;
    if (body[dataEnd - 2] === 13 && body[dataEnd - 1] === 10) dataEnd -= 2;
    const nameMatch = /name="([^"]*)"/i.exec(headers);
    const fileMatch = /filename="([^"]*)"/i.exec(headers);
    parts.push({ name: nameMatch ? nameMatch[1] : '', filename: fileMatch ? fileMatch[1] : '', data: body.subarray(dataStart, dataEnd) });
    pos = next;
  }
  return parts;
}

async function transcribe(req, res) {
  const body = await readBody(req);
  const ctype = String(req.headers['content-type'] || '');
  const bm = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
  let filePart = null;
  let model = 'sensevoice-onnx';
  let language = 'zh';

  if (bm) {
    const boundary = bm[1] || bm[2];
    const parts = parseMultipart(body, boundary);
    for (const part of parts) {
      if (part.name === 'file' && part.data.length) filePart = part;
      if (part.name === 'model' && part.data.length) model = part.data.toString('utf8').trim() || model;
      if (part.name === 'language' && part.data.length) language = part.data.toString('utf8').trim() || language;
    }
  } else {
    // 兼容：直接把 WAV 当 body 塞进来
    filePart = { name: 'file', data: body };
  }

  if (!filePart) {
    return json(res, 400, { error: { message: '没找到 file 字段（要 multipart 里的 file=16k 单声道 WAV）' } });
  }

  const { samples, sampleRate, seconds } = wavToSamples(filePart.data);
  if (!samples.length) {
    return json(res, 400, { error: { message: 'WAV 是空的' } });
  }
  if (sampleRate !== 16000) {
    return json(res, 400, { error: { message: `采样率必须是 16000（拿到 ${sampleRate}），先 ffmpeg -ar 16000 转一遍` } });
  }

  const rec = ensureRecognizer();
  const t0 = Date.now();
  const stream = rec.createStream();
  stream.acceptWaveform({ samples, sampleRate });
  rec.decode(stream);
  const result = rec.getResult(stream);
  const segments = buildSegments(result, seconds);
  const ms = Date.now() - t0;

  log(`transcribe ${(filePart.data.length / 1024).toFixed(0)}KB ${seconds.toFixed(1)}s → ${segments.length} 段 ${ms}ms`);

  return json(res, 200, {
    task: 'transcribe',
    model,
    language,
    duration: Number(seconds.toFixed(2)),
    text: result.text || '',
    segments,
  });
}

try {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.writeFileSync(LOG, '', 'utf8'); // 每次启动覆盖写，只留这一次的
} catch { /* 忽略 */ }

const server = http.createServer((req, res) => {
  touch();
  const url = String(req.url || '/').split('?')[0];
  if (req.method === 'GET' && url === '/health') {
    return json(res, 200, { ok: true, model: 'sensevoice-onnx', ready: Boolean(recognizer) });
  }
  if (req.method === 'POST' && url === '/shutdown') {
    json(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 80);
    return undefined;
  }
  if (req.method === 'POST' && (url === '/v1/audio/transcriptions' || url === '/audio/transcriptions')) {
    return transcribe(req, res).catch((err) => {
      log('transcribe failed:', err && err.message ? err.message : String(err));
      json(res, 500, { error: { message: String(err && err.message ? err.message : err) } });
    });
  }
  return json(res, 404, { error: { message: `没有这个路由：${req.method} ${url}` } });
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}  (idle ${IDLE_MS}ms)`);
  touch();
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
