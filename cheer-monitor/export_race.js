// 将 data/ 里的监控数据打包成"单个自包含 HTML 回放文件"
// 用法: node export_race.js
// 输出: 上级目录/Hackday2026_点赞角逐.html (双击即可在浏览器打开)
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const TEAMS_FILE = path.join(DATA_DIR, 'teams.json');
const LIKES_FILE = path.join(DATA_DIR, 'likes.jsonl');
const TEMPLATE = path.join(__dirname, 'race_template.html');
const OUT = path.join(__dirname, '..', 'Hackday2026_点赞角逐.html');

const teams = JSON.parse(fs.readFileSync(TEAMS_FILE, 'utf8'));
const lines = fs.readFileSync(LIKES_FILE, 'utf8').trim().split('\n').filter(Boolean);
const samples = lines.map((l) => JSON.parse(l));

if (!samples.length) {
  console.error('❌ data/likes.jsonl 为空,没有可导出的数据');
  process.exit(1);
}

// 内联数据(把 < 转义成 <,防止数据内容意外截断 </script>)
const payload = JSON.stringify({ teams, samples }).replace(/</g, '\\u003c');
let html = fs.readFileSync(TEMPLATE, 'utf8');
html = html.replace('__DATA_JSON__', payload);
fs.writeFileSync(OUT, html);

const t0 = new Date(samples[0].t);
const tN = new Date(samples[samples.length - 1].t);
const last = samples[samples.length - 1].counts;
const top = Object.entries(last).sort((a, b) => b[1] - a[1]).slice(0, 3)
  .map(([id, c]) => `${(teams.find(t => t.id == id) || {}).name} ${c}`).join(' | ');

console.log('✅ 导出完成');
console.log('   文件:', OUT);
console.log(`   大小: ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB`);
console.log(`   数据: ${teams.length} 队 × ${samples.length} 快照 (${t0.toLocaleTimeString('zh-CN', { hour12: false })} → ${tN.toLocaleTimeString('zh-CN', { hour12: false })})`);
console.log(`   最终前三: ${top}`);
