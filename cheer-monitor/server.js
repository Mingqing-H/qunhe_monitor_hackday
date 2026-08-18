// Hackday 2026 点赞监控 - 本地代理 + 数据记录服务
// 作用:
//   1. 转发 /api/showcase 到远程接口(规避浏览器 CORS)
//   2. 后台独立轮询并落盘记录点赞数据(data/likes.jsonl + data/teams.json)
//   3. 提供 CSV / JSONL 导出,方便后续分析
// 用法:
//   node server.js                          # 默认端口 8787,记录间隔 30s
//   PORT=9000 RECORD_INTERVAL=10000 node server.js   # 自定义端口/记录间隔(ms, 0=关闭记录)
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const UPSTREAM = 'https://hackday.qunhequnhe.com';
const PORT = Number(process.env.PORT) || 8787;
const ROOT = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const TEAMS_FILE = path.join(DATA_DIR, 'teams.json');
const LIKES_FILE = path.join(DATA_DIR, 'likes.jsonl');
const RECORD_INTERVAL = Number(process.env.RECORD_INTERVAL || 30000); // 记录间隔(ms), 0 = 关闭记录

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';

// 拉取上游接口,返回 (err, statusCode, body)
function fetchJson(pathname, cb) {
  const u = new URL(UPSTREAM + pathname);
  const preq = https.request(u, {
    method: 'GET',
    headers: { 'User-Agent': AGENT, 'Accept': 'application/json' },
  }, (pres) => {
    let body = '';
    pres.setEncoding('utf8');
    pres.on('data', (c) => {
      body += c;
      if (body.length > 5e6) preq.destroy();
    });
    pres.on('end', () => cb(null, pres.statusCode, body));
  });
  preq.on('error', (e) => cb(e));
  preq.setTimeout(10000, () => preq.destroy(new Error('timeout')));
  preq.end();
}

/* ---------------- 数据记录 ---------------- */
const recordStatus = { samples: 0, lastT: 0, lastError: '' };

// 服务重启后从文件恢复记录计数/最后时间,避免显示"0 条"
function initStatusFromFile() {
  try {
    const content = fs.readFileSync(LIKES_FILE, 'utf8').trim();
    if (!content) return;
    const lines = content.split('\n');
    recordStatus.samples = lines.length;
    const last = JSON.parse(lines[lines.length - 1]);
    recordStatus.lastT = last.t || 0;
  } catch {}
}

function loadTeams() {
  try { return JSON.parse(fs.readFileSync(TEAMS_FILE, 'utf8')); } catch { return []; }
}

function recordOnce() {
  fetchJson('/api/showcase', (err, code, body) => {
    if (err || code !== 200) {
      recordStatus.lastError = err ? err.message : 'HTTP ' + code;
      return;
    }
    let data;
    try { data = JSON.parse(body); } catch { recordStatus.lastError = '响应解析失败'; return; }
    if (!data.success || !Array.isArray(data.teams)) { recordStatus.lastError = '响应结构异常'; return; }
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });

      // 合并队伍元数据(新增队伍追加,已有队伍更新字段)
      const merged = loadTeams();
      const seen = new Set(merged.map((t) => t.id));
      for (const t of data.teams) {
        const meta = { id: t.id, name: t.name, track_name: t.track_name, leader_name: t.leader_name };
        if (seen.has(t.id)) {
          const idx = merged.findIndex((m) => m.id === t.id);
          merged[idx] = { ...meta };
        } else {
          seen.add(t.id);
          merged.push(meta);
        }
      }
      merged.sort((a, b) => a.id - b.id);
      fs.writeFileSync(TEAMS_FILE, JSON.stringify(merged, null, 2));

      // 追加点赞/评论快照
      const counts = {}, comments = {};
      for (const t of data.teams) {
        counts[t.id] = t.like_count;
        comments[t.id] = t.comment_count;
      }
      const line = JSON.stringify({ t: Date.now(), counts, comments });
      fs.appendFileSync(LIKES_FILE, line + '\n');

      recordStatus.samples++;
      recordStatus.lastT = Date.now();
      recordStatus.lastError = '';
    } catch (e) {
      recordStatus.lastError = e.message;
    }
  });
}

// 长格式 CSV 导出: t,team_id,team_name,track_name,leader_name,like_count,comment_count
function buildCsv() {
  const teams = loadTeams();
  const byId = {};
  for (const t of teams) byId[t.id] = t;
  const cell = (v) => {
    v = String(v == null ? '' : v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const rows = ['t,team_id,team_name,track_name,leader_name,like_count,comment_count'];
  const content = fs.readFileSync(LIKES_FILE, 'utf8').trim();
  if (content) {
    for (const line of content.split('\n')) {
      let snap;
      try { snap = JSON.parse(line); } catch { continue; }
      const tstr = new Date(snap.t).toISOString();
      for (const [id, c] of Object.entries(snap.counts || {})) {
        const m = byId[id];
        rows.push([
          tstr, id,
          cell(m ? m.name : id),
          cell(m ? m.track_name : ''),
          cell(m ? m.leader_name : ''),
          c,
          (snap.comments && snap.comments[id] != null) ? snap.comments[id] : '',
        ].join(','));
      }
    }
  }
  return rows.join('\n');
}

function sendRecordStatus(res) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({
    success: true,
    recording: RECORD_INTERVAL > 0,
    interval_ms: RECORD_INTERVAL,
    samples: recordStatus.samples,
    last_t: recordStatus.lastT,
    last_error: recordStatus.lastError,
    data_dir: DATA_DIR,
  }));
}

/* ---------------- HTTP 服务 ---------------- */
const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }

  // 数据导出 / 状态接口
  if (pathname === '/api/record/status') return sendRecordStatus(res);
  if (pathname === '/api/record/history') {
    // 返回已记录历史,供前端刷新后重建图表(最多返回最近 1500 条,外加首个样本作累计基线)
    const teams = loadTeams();
    const samples = [];
    let first = null;
    try {
      const content = fs.readFileSync(LIKES_FILE, 'utf8').trim();
      if (content) {
        const lines = content.split('\n');
        for (const line of lines) {
          try { samples.push(JSON.parse(line)); } catch {}
        }
        if (samples.length) first = samples[0];
      }
    } catch {}
    const slice = samples.slice(-1500);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ success: true, teams, first, samples: slice, total_samples: samples.length }));
    return;
  }
  if (pathname === '/download/csv') {
    let csv;
    try { csv = buildCsv(); } catch (e) { res.writeHead(500); res.end('导出失败: ' + e.message); return; }
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    const name = `hackday_likes_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.csv`;
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    });
    res.end('﻿' + csv); // BOM 保证 Excel 正确识别 UTF-8 中文
    return;
  }
  if (pathname === '/download/likes.jsonl') return sendFile(res, LIKES_FILE, 'likes.jsonl');
  if (pathname === '/download/teams.json') return sendFile(res, TEAMS_FILE, 'teams.json');

  // 代理上游 API
  if (pathname.startsWith('/api/')) {
    return fetchJson(pathname, (err, code, body) => {
      if (err || !code) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end('{"success":false,"message":"proxy error"}');
        return;
      }
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
    });
  }

  // 静态资源
  let file = pathname === '/' ? '/index.html' : pathname;
  const abs = path.normalize(path.join(ROOT, file));
  if (!abs.startsWith(ROOT)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(abs, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(content);
  });
});

function sendFile(res, file, downloadName) {
  fs.readFile(file, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found(还没有数据,稍等记录器写入)');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${downloadName}"`,
      'Cache-Control': 'no-store',
    });
    res.end(content);
  });
}

server.listen(PORT, () => {
  initStatusFromFile();
  const recInfo = RECORD_INTERVAL > 0
    ? `📊 数据记录已开启: 每 ${RECORD_INTERVAL / 1000}s 一条, 写入 ${path.relative(__dirname, DATA_DIR)}/`
    : '📊 数据记录已关闭 (RECORD_INTERVAL=0)';
  console.log(`🎉 Hackday 点赞监控已启动: http://localhost:${PORT}`);
  console.log(recInfo);
  console.log('   CSV 导出: http://localhost:' + PORT + '/download/csv');

  if (RECORD_INTERVAL > 0) {
    recordOnce();
    setInterval(recordOnce, RECORD_INTERVAL);
  }

  if (!process.argv.includes('--no-open')) {
    exec(`start "" "http://localhost:${PORT}"`);
  }
});
