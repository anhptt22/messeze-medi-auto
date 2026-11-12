// medi-lib.js — 메세지AI 메디(medi.messeze.com) 칼럼 공용 도우미
// 질문표(구글 시트 → CSV) 파싱·동기화 · 질문 고르기(고민 유형·지역·진료과 순환, 중복 회피) · 사이트 기존 글 목록 · 설정 · 경로
const fs = require('fs');
const path = require('path');
const https = require('https');
const SAFE = require('./safe-json');
const CONF = require('./config');

const SITE = 'https://medi.messeze.com';
// 관리자 [분류]에 만들 수 있는 분류. 처음 3개는 이미 있다. 4번째는 사용자가 관리자에서 만든 뒤에만 켠다.
const ALL_CATS = ['병원 검색 노출', 'AI 답변', '병원 정보 관리', '병원 마케팅 운영'];
const DEFAULT_CATS = ['병원 검색 노출', 'AI 답변', '병원 정보 관리'];
const FALLBACK_CAT = '병원 검색 노출'; // 매핑된 분류가 꺼져 있으면 여기로 보낸다
// 고민 유형 → 분류(관리자 [분류] 이름)
const CONCERN_CAT = {
  '신환 감소': '병원 검색 노출', '네이버 검색': '병원 검색 노출', '홈페이지': '병원 검색 노출', '경쟁 병원': '병원 검색 노출',
  'AI 답변': 'AI 답변',
  '네이버 플레이스': '병원 정보 관리', '개원과 이전': '병원 정보 관리',
  '블로그 대행': '병원 마케팅 운영', '대행사 선택': '병원 마케팅 운영', '비용과 예산': '병원 마케팅 운영',
};
// 기본 질문표(사용자가 공유한 구글 시트) — 설정 medi_config.json 의 questionSheetUrl 로 바꿀 수 있다
const DEFAULT_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1vI06eNGb9uktJ_kZR-y7HhKKbp6hOIWTc_VyaMw0F9E/edit?usp=sharing';

const QUEUE = path.join(__dirname, 'queue_medi.json');
const CONFIG = path.join(__dirname, 'medi_config.json');
const TOPICS = path.join(__dirname, 'medi_column_topics_log.txt');
// 구글 시트에서 새로 받은 질문표는 여기에 둔다(저장소 파일을 건드리지 않아야 원격 업데이트가 막히지 않는다)
const SYNCED_BANK = path.join(__dirname, 'data', '질문표_동기화.csv');

function docsDir() { return CONF.load().promptsDir; }
const PROMPT_FILE = () => CONF.load().medi.enginePrompt || path.join(docsDir(), '메세지_메디칼럼_자동작성_프롬프트.md');
const SHIPPED_BANK = () => path.join(docsDir(), '메세지_메디_질문표_v2.csv');
const BANK_FILE = () => (fs.existsSync(SYNCED_BANK) ? SYNCED_BANK : SHIPPED_BANK()); // 동기화본이 있으면 그것, 없으면 저장소에 든 질문표
const OUT_DIR = () => CONF.load().medi.outputDir;
const SESSION_DIR = () => CONF.load().medi.sessionDir;

function loadQueue() { return SAFE.readJsonSafe(QUEUE, { posts: [] }); }
function saveQueue(q) { return SAFE.writeJsonSafe(QUEUE, q, { guardKey: 'posts' }); }

function loadConfig() {
  const c = SAFE.readJsonSafe(CONFIG, {}) || {};
  const cats = Array.isArray(c.availableCats) && c.availableCats.length ? c.availableCats.filter(x => ALL_CATS.includes(x)) : DEFAULT_CATS;
  return { availableCats: cats.length ? cats : DEFAULT_CATS, questionSheetUrl: c.questionSheetUrl || DEFAULT_SHEET_URL, lastSync: c.lastSync || '' };
}
function saveConfig(patch) {
  let cur = {}; try { cur = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch {}
  fs.writeFileSync(CONFIG, JSON.stringify({ ...cur, ...patch }, null, 2), 'utf8');
}

// ── CSV(따옴표·쉼표·줄바꿈 처리) ──
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(f); f = ''; rows.push(row); row = []; }
    else f += c;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => String(x).trim()));
}

// ── 질문표: 번호,지역,진료과,진료항목,고민 유형,질문 → MQ001… ──
function loadBank() {
  let txt = '';
  try { txt = fs.readFileSync(BANK_FILE(), 'utf8'); } catch { return []; }
  const rows = parseCsv(txt);
  if (!rows.length) return [];
  const head = rows[0].map(x => x.trim());
  const ix = (n) => head.indexOf(n);
  const [iN, iR, iD, iI, iC, iQ] = ['번호', '지역', '진료과', '진료항목', '고민 유형', '질문'].map(ix);
  if ([iN, iR, iD, iI, iC, iQ].some(v => v < 0)) return [];
  const on = new Set(loadConfig().availableCats);
  const out = [];
  for (const r of rows.slice(1)) {
    const n = Number(String(r[iN]).trim()); const q = String(r[iQ] || '').trim();
    if (!n || !q) continue;
    let cat = CONCERN_CAT[String(r[iC]).trim()] || FALLBACK_CAT;
    if (!on.has(cat)) cat = on.has(FALLBACK_CAT) ? FALLBACK_CAT : [...on][0];
    out.push({ no: 'MQ' + String(n).padStart(3, '0'), n, region: r[iR].trim(), dept: r[iD].trim(), item: r[iI].trim(), concern: r[iC].trim(), q, title: q, cat });
  }
  return out;
}

// 구글 시트 → CSV 로 받아 로컬 질문표를 갱신한다(실패하면 기존 로컬 파일을 그대로 쓴다)
function sheetCsvUrl(u) {
  const m = String(u).match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) return '';
  const g = (String(u).match(/[#&?]gid=(\d+)/) || [])[1];
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv${g ? '&gid=' + g : ''}`;
}
function getRaw(url, ms = 30000, hops = 0) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: ms }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 5) { res.resume(); return resolve(getRaw(new URL(res.headers.location, url).href, ms, hops + 1)); }
      if (res.statusCode !== 200) { res.resume(); return resolve({ status: res.statusCode, text: '', type: '' }); }
      res.setEncoding('utf8'); let b = '';
      res.on('data', c => b += c); res.on('end', () => resolve({ status: 200, text: b, type: String(res.headers['content-type'] || '') }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, text: '', type: '' }); });
    req.on('error', () => resolve({ status: 0, text: '', type: '' }));
  });
}
async function syncQuestions(log = () => {}) {
  const conf = loadConfig();
  const url = sheetCsvUrl(conf.questionSheetUrl);
  if (!url) { log('! 질문표 주소(questionSheetUrl)가 올바르지 않습니다'); return { ok: false, msg: '주소 오류' }; }
  const r = await getRaw(url);
  if (r.status !== 200 || !/csv|text/i.test(r.type)) { log(`! 질문표를 받지 못했습니다(HTTP ${r.status}) — 기존 로컬 질문표를 그대로 씁니다. 시트가 "링크가 있는 모든 사용자: 보기"인지 확인하세요.`); return { ok: false, msg: 'HTTP ' + r.status }; }
  const rows = parseCsv(r.text);
  const head = (rows[0] || []).map(x => x.trim()).join(',');
  if (!head.startsWith('번호,지역,진료과,진료항목,고민 유형,질문') || rows.length < 20) { log('! 받은 질문표의 열 구성이 달라 갱신하지 않았습니다 (열: 번호,지역,진료과,진료항목,고민 유형,질문)'); return { ok: false, msg: '열 구성 다름' }; }
  const old = (() => { try { return fs.readFileSync(BANK_FILE(), 'utf8'); } catch { return ''; } })();
  const body = '﻿' + r.text.replace(/^﻿/, '');
  if (old.replace(/^﻿/, '') !== body.replace(/^﻿/, '')) {
    fs.mkdirSync(path.dirname(SYNCED_BANK), { recursive: true });
    if (fs.existsSync(SYNCED_BANK)) fs.copyFileSync(SYNCED_BANK, SYNCED_BANK + '.bak_' + new Date().toISOString().slice(0, 10));
    fs.writeFileSync(SYNCED_BANK, body, 'utf8');
    log(`질문표 갱신: ${rows.length - 1}문항`);
  } else log(`질문표 변경 없음 (${rows.length - 1}문항)`);
  saveConfig({ lastSync: new Date().toISOString() });
  return { ok: true, n: rows.length - 1 };
}

function usedQuestions() {
  const used = new Set();
  try { for (const l of fs.readFileSync(TOPICS, 'utf8').split(/\r?\n/)) { const m = l.match(/\[(MQ\d+)\]/); if (m) used.add(m[1]); } } catch {}
  for (const it of (loadQueue().posts || [])) { if (it.q_no && it.status !== 'rejected') used.add(String(it.q_no)); }
  return used;
}

// 같은 고민 유형·지역·진료과가 연달아 나오지 않게 순환하며, 남은 질문이 많은 유형부터 고른다
function pickQuestion({ excludeNos = [] } = {}) {
  const bank = loadBank();
  const used = usedQuestions(); excludeNos.forEach(x => used.add(x));
  const pool = bank.filter(r => !used.has(r.no));
  if (!pool.length) return null;
  const byNo = {}; bank.forEach(r => byNo[r.no] = r);
  const recent = (loadQueue().posts || []).filter(x => x.status !== 'rejected' && byNo[x.q_no]).slice(-8).map(x => byNo[x.q_no]);
  const last = (k, n) => new Set(recent.slice(-n).map(r => r[k]));
  const stages = [
    (r) => !last('concern', 2).has(r.concern) && !last('region', 6).has(r.region) && !last('dept', 1).has(r.dept),
    (r) => !last('concern', 2).has(r.concern) && !last('region', 4).has(r.region),
    (r) => !last('concern', 1).has(r.concern) && !last('region', 2).has(r.region),
    (r) => !last('concern', 1).has(r.concern),
    () => true,
  ];
  let cand = [];
  for (const f of stages) { cand = pool.filter(f); if (cand.length) break; }
  // 남은 문항이 가장 많은 고민 유형 우선(유형별 소진 속도를 맞춘다)
  const cnt = {}; pool.forEach(r => cnt[r.concern] = (cnt[r.concern] || 0) + 1);
  const best = Math.max(...cand.map(r => cnt[r.concern]));
  const top = cand.filter(r => cnt[r.concern] >= best - 1);
  return top[Math.floor(Math.random() * top.length)];
}

// ── 네트워크 ──
function getText(url, ms = 20000) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: ms }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve({ status: res.statusCode, text: '' }); }
      res.setEncoding('utf8'); let b = '';
      res.on('data', c => b += c); res.on('end', () => resolve({ status: 200, text: b }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, text: '' }); });
    req.on('error', () => resolve({ status: 0, text: '' }));
  });
}
const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");

// 메디에 이미 올라온 글: sitemap 의 /blog/<slug> + 각 글 <title>
async function liveMediPosts() {
  const sm = await getText(SITE + '/sitemap.xml');
  const slugs = [...sm.text.matchAll(/<loc>https:\/\/medi\.messeze\.com\/blog\/([^<\/]+)<\/loc>/g)].map(m => m[1]);
  const out = [];
  for (let i = 0; i < slugs.length; i += 6) {
    const part = await Promise.all(slugs.slice(i, i + 6).map(async (slug) => {
      const r = await getText(`${SITE}/blog/${slug}`);
      const t = (r.text.match(/<title>([^<]*)<\/title>/) || [])[1];
      return { slug, title: decode(t).trim() };
    }));
    out.push(...part);
  }
  return out;
}
async function mainSiteTitles() {
  const r = await getText('https://messeze.com/data/posts.json');
  try { return JSON.parse(r.text).map(p => `${p.cat} | ${p.title}`); } catch { return []; }
}
async function slugIsLive(slug) { return (await getText(`${SITE}/blog/${encodeURIComponent(slug)}`, 15000)).status === 200; }

function appendTopics(line) { try { fs.appendFileSync(TOPICS, line + '\n', 'utf8'); } catch {} }

// ════════════════════════════════════════════════════════════════════
// 블로거·티스토리용 질문 배정 — 질문표에서 블로그(진료과)별로 프로그램이 고른다
//   · 블로그 설정: depts(쓰는 진료과) / exceptDepts(빼는 진료과) / variant(질문표에 그 진료과가 없을 때 바꿔 쓰는 규칙)
//   · 같은 채널에서 한 번 쓴 질문은 다시 쓰지 않는다(다 쓰면 가장 오래전에 쓴 것부터 다른 각도로).
//   · 같은 날 다른 채널(블로거↔티스토리↔홈페이지 칼럼)이 쓴 질문은 피한다.
// ════════════════════════════════════════════════════════════════════
const CH_QUEUE = { blogger: path.join(__dirname, 'queue.json'), tistory: path.join(__dirname, 'queue_tistory.json') };
const CH_PREFIX = { blogger: 'medi_post', tistory: 'medi_tistory' };
const qKey = (no, variant) => String(no || '') + (variant ? '·' + variant : '');
const ymd = () => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; };
function chPosts(channel) { return (SAFE.readJsonSafe(CH_QUEUE[channel], { posts: [] }).posts || []).filter(p => p.status !== 'rejected'); }
function blogKey(channel, blog) { return channel === 'tistory' ? String(blog.account || '') : String(blog.url || '').replace(/\/$/, ''); }
function postBlogKey(channel, p) { return channel === 'tistory' ? String(p.account || '') : String(p.blog_url || '').replace(/\/$/, ''); }

// 질문표 한 행을 다른 진료과(예: 동물병원) 각도로 바꾼다 — 지역·고민 유형은 그대로, 진료과·진료항목만 바꾼다
function variantRow(r, v) {
  const items = (v && v.items) || [];
  if (!v || !v.dept || !items.length || !r.q.includes(r.dept) || !r.q.includes(r.item)) return null;
  // 사람 병원에만 맞는 전제가 들어 있는 질문은 바꿔 쓰지 않는다
  const skip = new RegExp(v.skip || '기업|학부모|학생|직장|어르신|산모|임산|임신|출산|아이|어린이|소아|청소년|수험|실비|실손|보험|외국|군인|노인|여성|남성|검진센터|통증|수술 후기|전후|영유아');
  if (skip.test(r.q)) return null;
  const item = items[r.n % items.length];
  let q = r.q.split(r.dept).join(v.dept).split(r.item).join(item).replace(/신환/g, '신규 내원').replace(/환자/g, '보호자');
  // 바꿔 넣은 낱말 뒤의 조사(와/과·은/는·이/가·을/를)를 받침에 맞춘다
  const hasBatchim = (w) => { const c = w.charCodeAt(w.length - 1); return c >= 0xAC00 && c <= 0xD7A3 && (c - 0xAC00) % 28 !== 0; };
  const J = [['와', '과'], ['는', '은'], ['가', '이'], ['를', '을']];
  for (const w of [v.dept, item]) {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    q = q.replace(new RegExp(esc + '(와|과|은|는|이|가|을|를)(?=[\\s,?.!]|$)', 'g'), (m, j) => { const p = J.find(x => x.includes(j)); return w + (hasBatchim(w) ? p[1] : p[0]); });
  }
  return { ...r, dept: v.dept, item, q, title: q, variant: v.dept, origDept: r.dept, origItem: r.item };
}
function rowsForBlog(blog, bank) {
  const d = Array.isArray(blog.depts) ? blog.depts : [];
  const x = Array.isArray(blog.exceptDepts) ? blog.exceptDepts : [];
  let own = d.length ? bank.filter(r => d.includes(r.dept)) : bank.filter(r => !x.includes(r.dept));
  // 질문표에 이 블로그의 진료과 문항이 거의 없으면(20개 미만) 다른 진료과 질문을 바꿔서 채운다
  if (blog.variant && own.length < 20) own = own.concat(bank.filter(r => !d.includes(r.dept)).map(r => variantRow(r, blog.variant)).filter(Boolean));
  return own;
}

// 오늘 다른 곳에서 이미 쓴(쓰기로 한) 질문 번호 — 채널 무관
function todayNos() {
  const set = new Set(); const t = ymd();
  for (const ch of Object.keys(CH_QUEUE)) for (const p of chPosts(ch)) if (String(p.file || '').startsWith(CH_PREFIX[ch] + t + '_') && p.q_no) set.add(String(p.q_no));
  const d = `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6)}`;
  for (const it of (loadQueue().posts || [])) if (it.status !== 'rejected' && it.created === d && it.q_no) set.add(String(it.q_no));
  return set;
}

// 블로그 1개에 줄 질문 1개. exclude = 이번 배정에서 이미 다른 블로그에 준 번호
function pickForBlog(channel, blog, { exclude = new Set(), avoidNo = '' } = {}) {
  const bank = loadBank();
  const rows = rowsForBlog(blog, bank);
  if (!rows.length) return null;
  const posts = chPosts(channel);
  const usedKeys = posts.filter(p => p.q_no).map(p => qKey(p.q_no, p.q_variant));
  const usedSet = new Set(usedKeys);
  const busy = new Set([...todayNos(), ...exclude]); if (avoidNo) busy.add(String(avoidNo));
  let recycled = false;
  let pool = rows.filter(r => !usedSet.has(qKey(r.no, r.variant)) && !busy.has(r.no));
  if (!pool.length) {
    // 이 채널에서 다 썼다 → 가장 오래전에 쓴 것부터(최근 40건은 제외) 다른 각도로 다시 쓴다
    const recent = new Set(usedKeys.slice(-40));
    pool = rows.filter(r => !recent.has(qKey(r.no, r.variant)) && !busy.has(r.no));
    if (!pool.length) pool = rows.filter(r => !busy.has(r.no));
    recycled = true;
  }
  if (!pool.length) return null;
  // 이 블로그의 최근 글과 고민 유형·지역·진료과가 연달아 겹치지 않게
  const mine = posts.filter(p => postBlogKey(channel, p) === blogKey(channel, blog) && p.concern).slice(-6);
  const last = (k, n) => new Set(mine.slice(-n).map(p => p[k]).filter(Boolean));
  const stages = [
    (r) => !last('concern', 3).has(r.concern) && !last('region', 5).has(r.region) && !last('dept', 1).has(r.dept),
    (r) => !last('concern', 2).has(r.concern) && !last('region', 3).has(r.region),
    (r) => !last('concern', 1).has(r.concern),
    () => true,
  ];
  let cand = [];
  for (const f of stages) { cand = pool.filter(f); if (cand.length) break; }
  const cnt = {}; pool.forEach(r => cnt[r.concern] = (cnt[r.concern] || 0) + 1);
  const best = Math.max(...cand.map(r => cnt[r.concern]));
  const top = cand.filter(r => cnt[r.concern] >= best - 1);
  return { row: top[Math.floor(Math.random() * top.length)], recycled };
}

// 이번 실행의 배정표: [{ blog, row, recycled }] — onlyN 이 있으면 그 블로그 1개만
function planFor(channel, cfg, onlyN) {
  const list = channel === 'tistory' ? ((cfg.tistory || {}).blogs || []) : (cfg.blogs || []);
  const blogs = onlyN ? list.filter(b => b.n === Number(onlyN)) : list;
  const exclude = new Set(); const plan = [];
  for (const blog of blogs) {
    const r = pickForBlog(channel, blog, { exclude });
    if (!r) continue;
    exclude.add(r.row.no);
    plan.push({ blog: { n: blog.n, name: blog.name, url: blog.url || '', account: blog.account || '' }, row: r.row, recycled: r.recycled });
  }
  return plan;
}

// 생성이 끝난 뒤: 새로 올라온 큐 항목에 질문 정보(번호·질문·지역·진료과·항목·고민 유형)를 프로그램이 확정해 적는다
function stampPlan(channel, plan, isFresh) {
  if (!plan || !plan.length) return 0;
  const q = SAFE.readJsonSafe(CH_QUEUE[channel], { posts: [] });
  let n = 0;
  for (const it of plan) {
    const key = blogKey(channel, it.blog);
    const p = (q.posts || []).filter(x => isFresh(x) && postBlogKey(channel, x) === key).pop();
    if (!p) continue;
    const r = it.row;
    Object.assign(p, { q_no: r.no, question: r.q, region: r.region, dept: r.dept, item: r.item, concern: r.concern });
    if (r.variant) p.q_variant = r.variant; else delete p.q_variant;
    n++;
  }
  if (n) SAFE.writeJsonSafe(CH_QUEUE[channel], q, { guardKey: 'posts' });
  return n;
}
// 채널별 남은 질문 수(블로그별) — 대시보드 표시용
function leftByBlog(channel, cfg) {
  const bank = loadBank();
  const used = new Set(chPosts(channel).filter(p => p.q_no).map(p => qKey(p.q_no, p.q_variant)));
  const list = channel === 'tistory' ? ((cfg.tistory || {}).blogs || []) : (cfg.blogs || []);
  return list.map(b => { const rows = rowsForBlog(b, bank); return { n: b.n, total: rows.length, left: rows.filter(r => !used.has(qKey(r.no, r.variant))).length, variant: !!(rows[0] && rows.some(r => r.variant)) }; });
}

module.exports = { SITE, ALL_CATS, DEFAULT_CATS, CONCERN_CAT, QUEUE, CONFIG, TOPICS, PROMPT_FILE, BANK_FILE, OUT_DIR, SESSION_DIR,
  planFor, pickForBlog, stampPlan, leftByBlog, rowsForBlog, variantRow,
  loadQueue, saveQueue, loadConfig, saveConfig, loadBank, syncQuestions, usedQuestions, pickQuestion, getText, liveMediPosts, mainSiteTitles, slugIsLive, appendTopics, decode };
