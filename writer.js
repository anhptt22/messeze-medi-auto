// writer.js — 메세지 메디(messeze medi) 자동화 대시보드: 블로거 4 + 티스토리 4 + 홈페이지 칼럼(medi.messeze.com)
// 실행: node writer.js              → http://127.0.0.1:5015 (UI)
//       node writer.js --batch     → 오늘 글 생성만 하고 종료(작업 스케줄러용)
// ★생성만으로는 발행되지 않는다. 발행은 대시보드에서 사람이 누른 글만.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const E = require('./engine');

const SAFE = require('./safe-json');
const UPD = require('./updater');
const UI = path.join(__dirname, 'writer-ui.html');
const JOB = { running: false, kind: '', logs: [], startedAt: 0 };
const LOGFILE = path.join(__dirname, 'job.log');
// 예기치 못한 오류가 나도 대시보드가 꺼지지 않게 (오류는 job.log 에 기록)
SAFE.installCrashGuard('메디 대시보드', LOGFILE);
function flog(m) { try { fs.appendFileSync(LOGFILE, '[' + new Date().toISOString() + '] ' + m + '\n'); } catch {} }
function jlog(m) { JOB.logs.push(`[${new Date().toTimeString().slice(0, 8)}] ${m}`); if (JOB.logs.length > 600) JOB.logs.shift(); console.log(m); flog(m); }

// ── 자동 실행 상태(중복 트리거 방지) ──
function loadAuto() { try { return JSON.parse(fs.readFileSync(E.paths(E.loadCfg()).autoState, 'utf8')); } catch { return {}; } }
function saveAuto(st) { try { fs.writeFileSync(E.paths(E.loadCfg()).autoState, JSON.stringify(st, null, 2), 'utf8'); } catch {} }

async function jobGenerate(opts = {}) {
  const cfg = E.loadCfg();
  const existed = E.todayEntries(cfg);
  const only = opts.only ? (cfg.blogs || []).find(b => b.n === Number(opts.only)) : null;
  const want = only ? 1 : (cfg.postsPerRun || 5);
  if (!only && existed.length >= want && !opts.force) {
    jlog(`오늘(${E.today()}) 글 ${existed.length}건이 이미 큐에 있음 — 생성 건너뜀 (강제 생성은 force)`);
    return { skipped: true };
  }
  const beforeFiles = new Set(existed.map(p => p.file));
  jlog(`생성 시작 — 오늘 ${E.today()} · ${only ? `${only.n}번 블로그 「${only.name}」 1편` : `목표 ${want}건`} · 모델 ${cfg.model}`);
  jlog('  프롬프트: ' + cfg.enginePrompt);
  const M = require('./medi-lib');
  try { const sy = await M.syncQuestions((m) => jlog('  [질문표] ' + m)); if (!sy.ok) jlog('  (로컬 질문표 사용)'); } catch {}
  const plan = M.planFor('blogger', cfg, only && only.n);
  if (!plan.length) { jlog('! 질문표에서 쓸 질문을 찾지 못했습니다 — prompts 폴더의 질문표와 writer_config.json 의 depts 를 확인하세요.'); return { skipped: true, fresh: [] }; }
  plan.forEach(p => jlog(`  질문 배정: ${p.blog.n}. ${p.blog.name} ← ${p.row.no} ${p.row.q}${p.row.variant ? ' [' + p.row.variant + ' 변형]' : ''}${p.recycled ? ' [재사용]' : ''}`));
  const prompt = E.buildRunPrompt(cfg, { only: only && only.n, plan });
  const t0 = Date.now();
  const out = await E.runClaude(prompt, cfg, jlog);
  M.stampPlan('blogger', plan, p => !beforeFiles.has(p.file) && String(p.file || '').startsWith('medi_post' + E.todayCompact() + '_'));
  jlog(`  claude 종료 (${Math.round((Date.now() - t0) / 60000)}분) — 요약: ` + out.split(/\r?\n/).filter(Boolean).slice(-3).join(' / ').slice(0, 300));
  const rep = await E.postRunVerify(cfg, beforeFiles, jlog);
  const okN = rep.fresh.filter(r => !r.issues.length).length;
  jlog(`생성 완료: 신규 ${rep.fresh.length}건 (오류 없음 ${okN}건) · 오늘 총 ${rep.todayTotal}건 · 보관 폴더/발행정보 갱신됨`);
  if (rep.fresh.length < want) jlog(`! 신규 글이 ${rep.fresh.length}건뿐입니다 — job.log와 topics_log를 확인하세요.`);
  return rep;
}

// ── 티스토리 생성 — 티스토리 전용 프롬프트로 3건 작성(queue_tistory.json 적재까지) ──
async function jobGenerateTistory(opts = {}) {
  const cfg = E.loadCfg();
  const T = E.tcfg(cfg);
  if (!T.enabled) { jlog('티스토리 채널 비활성(writer_config.json tistory.enabled)'); return { skipped: true }; }
  const existed = E.todayEntriesTistory(cfg);
  const only = opts.only ? (T.blogs || []).find(b => b.n === Number(opts.only)) : null;
  const want = only ? 1 : (T.postsPerRun || 5);
  if (!only && existed.length >= want && !opts.force) {
    jlog(`오늘(${E.today()}) 티스토리 글 ${existed.length}건이 이미 큐에 있음 — 생성 건너뜀`);
    return { skipped: true };
  }
  const beforeFiles = new Set(existed.map(p => p.file));
  jlog(`티스토리 생성 시작 — 오늘 ${E.today()} · ${only ? `${only.n}번 블로그 「${only.name}」 1편` : `목표 ${want}건`} · 모델 ${cfg.model}`);
  jlog('  프롬프트: ' + T.enginePrompt);
  const M = require('./medi-lib');
  try { const sy = await M.syncQuestions((m) => jlog('  [질문표] ' + m)); if (!sy.ok) jlog('  (로컬 질문표 사용)'); } catch {}
  const plan = M.planFor('tistory', cfg, only && only.n);
  if (!plan.length) { jlog('! 질문표에서 쓸 질문을 찾지 못했습니다 — prompts 폴더의 질문표와 writer_config.json 의 depts 를 확인하세요.'); return { skipped: true, fresh: [] }; }
  plan.forEach(p => jlog(`  질문 배정: ${p.blog.n}. ${p.blog.name} ← ${p.row.no} ${p.row.q}${p.row.variant ? ' [' + p.row.variant + ' 변형]' : ''}${p.recycled ? ' [재사용]' : ''}`));
  const prompt = E.buildRunPromptTistory(cfg, { only: only && only.n, plan });
  const t0 = Date.now();
  const out = await E.runClaude(prompt, cfg, jlog);
  M.stampPlan('tistory', plan, p => !beforeFiles.has(p.file) && String(p.file || '').startsWith('medi_tistory' + E.todayCompact() + '_'));
  jlog(`  claude 종료 (${Math.round((Date.now() - t0) / 60000)}분) — 요약: ` + out.split(/\r?\n/).filter(Boolean).slice(-3).join(' / ').slice(0, 300));
  const rep = await E.postRunVerifyTistory(cfg, beforeFiles, jlog);
  const okN = rep.fresh.filter(r => !r.issues.length).length;
  jlog(`티스토리 생성 완료: 신규 ${rep.fresh.length}건 (오류 없음 ${okN}건) · 오늘 총 ${rep.todayTotal}건 · 발행정보_티스토리.txt 갱신됨`);
  if (rep.fresh.length < want) jlog(`! 신규 티스토리 글이 ${rep.fresh.length}건뿐입니다 — job.log 확인.`);
  return rep;
}

// ── 홈페이지 칼럼 생성 — 자동작성 프롬프트로 1편 작성(산출물 4종 + queue_homepage.json 적재까지) ──
async function jobGenerateHomepage(opts = {}) {
  const cfg = E.loadCfg();
  const H = E.hcfg(cfg);
  if (!H.enabled) { jlog('홈페이지 칼럼 채널 비활성(writer_config.json homepage.enabled)'); return { skipped: true }; }
  const existed = E.todayEntriesHomepage(cfg);
  if (existed.length >= (H.postsPerRun || 1) && !opts.force) {
    jlog(`오늘(${E.today()}) 홈페이지 칼럼 ${existed.length}건이 이미 큐에 있음 — 생성 건너뜀`);
    return { skipped: true };
  }
  const beforeFiles = new Set(existed.map(p => p.file));
  const want = Math.max(1, (H.postsPerRun || 1) - existed.length);
  jlog(`홈페이지 칼럼 생성 시작 — 오늘 ${E.today()} · 목표 ${H.postsPerRun || 1}건(이번 실행 ${want}편) · 모델 ${cfg.model}`);
  jlog('  프롬프트: ' + H.enginePrompt);
  const prompt = E.buildRunPromptHomepage(cfg);
  const t0 = Date.now();
  // 홈페이지는 편당 작업량이 커서 채널 전용 타임아웃을 쓴다(없으면 전역값)
  const runCfg = H.claudeTimeoutSec ? { ...cfg, claudeTimeoutSec: H.claudeTimeoutSec } : cfg;
  const out = await E.runClaude(prompt, runCfg, jlog);
  jlog(`  claude 종료 (${Math.round((Date.now() - t0) / 60000)}분) — 요약: ` + out.split(/\r?\n/).filter(Boolean).slice(-3).join(' / ').slice(0, 300));
  const rep = await E.postRunVerifyHomepage(cfg, beforeFiles, jlog);
  const okN = rep.fresh.filter(r => !r.issues.length).length;
  jlog(`홈페이지 칼럼 생성 완료: 신규 ${rep.fresh.length}건 (오류 없음 ${okN}건) · 산출물 4종 = ${path.join(E.pathsHomepage(cfg).outDir, E.today())}`);
  jlog(`  ※발행은 수동: admin 글 추가로 blog-*.html 생성 → 치환룰로 blog.html 카드 삽입 → 큐 [발행 처리]`);
  if (!rep.fresh.length) jlog('! 신규 칼럼이 없습니다 — job.log와 topics_log를 확인하세요.');
  return rep;
}

// ── 개별 글 다시 생성 (2026-08-15) — 큐 한 줄만 새로 쓴다 ──
//    mode: 'same' = 같은 주제·제목·슬러그 유지 / 'new' = 다른 주제로
async function jobRegenerate(channel, file, mode) {
  const cfg = E.loadCfg();
  const label = { blogger: '블로거', tistory: '티스토리', homepage: '홈페이지 칼럼' }[channel] || channel;
  jlog(`[다시 생성] ${label} · ${file} · ${mode === 'same' ? '같은 주제' : '새 주제'}`);
  // 질문은 프로그램이 정한다: same = 같은 질문 그대로 / new = 그 블로그의 다른 질문
  const M = require('./medi-lib');
  let pick = null, blog = null;
  if (channel !== 'homepage') {
    const list = channel === 'tistory' ? (E.tcfg(cfg).blogs || []) : (cfg.blogs || []);
    const e0 = (E.regenChannel(cfg, channel).queue.posts || []).find(p => p.file === file) || {};
    blog = list.find(b => channel === 'tistory' ? b.account === e0.account : (e0.blog_url && e0.blog_url.startsWith(String(b.url).replace(/\/$/, ''))));
    if (blog) {
      if (mode === 'same' && e0.q_no) { const row = M.rowsForBlog(blog, M.loadBank()).find(r => r.no === e0.q_no && (r.variant || '') === (e0.q_variant || '')); if (row) pick = { row, recycled: false }; }
      if (!pick) pick = M.pickForBlog(channel, blog, { avoidNo: e0.q_no });
      if (pick) jlog(`  질문 배정: ${pick.row.no} ${pick.row.q}`);
    }
  }
  const prep = E.prepareRegen(cfg, channel, file, jlog);   // 백업 + 큐에서 제거
  const beforeFiles = new Set(
    (channel === 'tistory' ? E.todayEntriesTistory(cfg)
      : channel === 'homepage' ? E.todayEntriesHomepage(cfg)
        : E.todayEntries(cfg)).map(p => p.file));
  const prompt = E.buildRegenPrompt(cfg, channel, prep.entry, mode, pick);
  const H = E.hcfg(cfg);
  const runCfg = (channel === 'homepage' && H.claudeTimeoutSec) ? { ...cfg, claudeTimeoutSec: H.claudeTimeoutSec } : cfg;
  const t0 = Date.now();
  const out = await E.runClaude(prompt, runCfg, jlog);
  jlog(`  claude 종료 (${Math.round((Date.now() - t0) / 60000)}분) — 요약: ` + out.split(/\r?\n/).filter(Boolean).slice(-3).join(' / ').slice(0, 300));
  if (pick && blog) M.stampPlan(channel, [{ blog, row: pick.row }], p => p.file === file);
  const rep = channel === 'tistory' ? await E.postRunVerifyTistory(cfg, beforeFiles, jlog)
    : channel === 'homepage' ? await E.postRunVerifyHomepage(cfg, beforeFiles, jlog)
      : await E.postRunVerify(cfg, beforeFiles, jlog);
  if (rep.fresh.length) jlog(`다시 생성 완료: ${rep.fresh.map(r => r.title || r.file).join(' / ')}`);
  else {
    // 오늘 날짜가 아닌 글은 '오늘 새 글' 집계에 안 잡힌다 — 큐에 다시 올라왔는지 직접 확인한다
    const back = (E.regenChannel(cfg, channel).queue.posts || []).some(p => p.file === file);
    if (back) jlog(`다시 생성 완료: ${file}`);
    else if (E.restoreRegen(cfg, channel, prep, jlog)) jlog('! 새 글이 만들어지지 않아 이전 글을 되돌렸습니다.');
    else jlog(`! 새 글이 큐에 올라오지 않았습니다 — 백업본은 ${prep.backup} 에 있습니다(job.log 확인).`);
  }
  return rep;
}

// ── 자식 프로세스 실행 공통(티스토리 발행기·로그인·카테고리) — 로그 스트리밍 ──
function spawnJob(script, args, timeoutMin) {
  return new Promise((resolve) => {
    const p = spawn('node', [script, ...args], { cwd: __dirname });
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
    p.stdout.on('data', d => String(d).split(/\r?\n/).filter(Boolean).forEach(l => jlog(l)));
    p.stderr.on('data', d => String(d).split(/\r?\n/).filter(Boolean).forEach(l => jlog(l)));
    const to = timeoutMin ? setTimeout(() => { try { p.kill(); } catch {} jlog(`${script} 시간 초과(${timeoutMin}분) — 중단`); resolve(1); }, timeoutMin * 60000) : null;
    p.on('close', (code) => { if (to) clearTimeout(to); resolve(code); });
    p.on('error', (e) => { if (to) clearTimeout(to); jlog(`${script} 실행 오류: ` + e.message); resolve(1); });
  });
}

// ── 티스토리 게시 — tistory-poster.js (Playwright, 브라우저 창이 열림) ──
async function jobPostTistory(mode, onlyFile) {
  const cfg = E.loadCfg();
  const T = E.tcfg(cfg);
  const args = [mode];
  if (onlyFile) args.push(onlyFile);
  args.push(String(T.publishStaggerMin ?? 5));
  jlog(`티스토리 게시 시작(${mode}) — 브라우저 창이 열립니다. 세션 만료 시 창에서 카카오 로그인하면 이어서 진행됩니다.`);
  const code = await spawnJob('tistory-poster.js', args, 120);
  jlog(code === 0 ? '티스토리 게시 종료(정상)' : `티스토리 게시 종료(코드 ${code}) — 위 로그 확인`);
}

// ── 게시(초안/공개) — Blogger API, 윈차이나·레드트랜스와 동일 방식 ──
// mode: 'draft' = 초안 등록 / 'publish' = 공개 발행(슬러그 트릭으로 영문 퍼머링크)
// onlyFile 없으면: 오늘 pending 중 블로그당 최신 1건씩. 발행 간격 publishStaggerMin(기본 5분).
async function jobPost(mode, onlyFile) {
  const poster = require('./poster');
  const cfg = E.loadCfg();
  const P = E.paths(cfg);
  const q = E.loadQueue(cfg);
  const saveQ = () => E.writeJsonSafe(P.queue, q, { guardKey: 'posts' });
  let items = (q.posts || []).filter(p => p.status === 'pending' || (mode === 'publish' && p.status === 'draft'));
  if (onlyFile) items = items.filter(p => p.file === onlyFile);
  else {
    items = items.filter(p => p.file.startsWith('medi_post' + E.todayCompact() + '_'));
    const byBlog = {};
    for (const p of items) byBlog[p.blog_url] = p; // 큐 순서 = 과거→최신, 마지막 항목이 최신
    const chosen = new Set(Object.values(byBlog).map(x => x.file));
    const dropped = items.filter(p => !chosen.has(p.file));
    if (dropped.length) jlog(`  (건너뜀 ${dropped.length}건: 블로그당 최신 1건만 게시 — ${dropped.map(d => d.file).join(', ')})`);
    items = items.filter(p => chosen.has(p.file));
  }
  if (!items.length) { jlog('게시할 글이 없습니다(오늘 pending 없음).'); return; }
  const stagger = cfg.publishStaggerMin ?? 5;
  jlog(`게시 시작: ${items.length}건 | 모드=${mode}${mode === 'publish' ? ` | 간격 ${stagger}분` : ''}`);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let publishedCount = 0;
  for (const p of items) {
    try {
      const blog = cfg.blogs.find(b => p.blog_url && p.blog_url.startsWith(b.url.replace(/\/$/, '')));
      if (!blog || !blog.blogId) { jlog(`  건너뜀(블로그 매칭 실패): ${p.file}`); continue; }
      const fp = path.join(P.posts, p.file);
      if (!fs.existsSync(fp)) { jlog(`  건너뜀(파일 없음): ${p.file}`); continue; }
      const html = fs.readFileSync(fp, 'utf8');
      let r;
      if (mode === 'draft') {
        if (p.post_id) { jlog(`  이미 초안 등록됨: ${p.file}`); continue; }
        r = await poster.insertDraft(blog, { title: p.title, html, labels: p.labels });
        p.post_id = r.id; p.status = 'draft';
      } else {
        if (publishedCount > 0 && stagger > 0) { jlog(`  ... 다음 발행까지 ${stagger}분 대기`); await sleep(stagger * 60000); }
        if (p.post_id) r = await poster.publishWithSlug(blog, p.post_id, p.slug, p.title);
        else { r = await poster.insertPublish(blog, { title: p.title, html, labels: p.labels, slug: p.slug }); p.post_id = r.id; }
        p.status = 'published'; p.published_url = r.url || ''; p.posted_at = new Date().toISOString();
        publishedCount++;
      }
      saveQ();
      jlog(`  OK ${blog.name} [${r.status}] ${String(p.title).slice(0, 32)}${r.url ? ' | ' + r.url : ''}`);
    } catch (e) { jlog(`  FAIL ${p.file} | ${e.message.slice(0, 120)}`); }
  }
  jlog(`게시 완료 — ※검색 설명(메타)은 API 입력 불가: 발행정보.txt 보고 Blogger 편집기에서 글별로 붙여넣으세요.`);
}

// ── 개별 글 손보기 (first 5100 과 같은 흐름: 생성 → 미리보기 → 제목 다시/이미지 교체/다시 쓰기 → 발행) ──
const HP_QUEUE = path.join(__dirname, 'queue_medi.json');   // 홈페이지 칼럼 = 메디 칼럼(medi.messeze.com) 큐

// 채널별 대상 글 찾기 → { title, html?, save(newTitle, newHtml), entry }
function locatePost(channel, key) {
  const cfg = E.loadCfg();
  if (channel === 'homepage') {
    const q = SAFE.readJsonSafe(HP_QUEUE, { posts: [] });
    const it = (q.posts || []).find(x => x.post && x.post.slug === key);
    if (!it) throw new Error('홈페이지 큐에서 찾지 못했습니다: ' + key);
    if (it.status === 'published') throw new Error('이미 발행된 글입니다');
    return { cfg, q, it, title: it.post.title, save: () => SAFE.writeJsonSafe(HP_QUEUE, q, { guardKey: 'posts' }) };
  }
  const P = channel === 'tistory' ? E.pathsTistory(cfg) : E.paths(cfg);
  const q = channel === 'tistory' ? E.loadQueueTistory(cfg) : E.loadQueue(cfg);
  const it = (q.posts || []).find(x => x.file === key);
  if (!it) throw new Error('큐에서 찾지 못했습니다: ' + key);
  if (it.status === 'published') throw new Error('이미 발행된 글입니다');
  const fp = path.join(P.posts, path.basename(key));
  if (!fs.existsSync(fp)) throw new Error('원고 파일이 없습니다: ' + key);
  return { cfg, q, it, fp, title: it.title, html: fs.readFileSync(fp, 'utf8'), save: () => E.writeJsonSafe(P.queue, q, { guardKey: 'posts' }) };
}

// 글 → 질문표 번호·질문. 큐의 q_no 가 있으면 그것, 없으면 topics_log(제목 변경 이력 포함)에서 찾는다
function questionIndex(cfg) {
  const bank = {};
  try { for (const r of require('./medi-lib').loadBank()) bank[r.no] = r.q; } catch {}
  const byTitle = {}, renamedFrom = {};
  try {
    for (const l of fs.readFileSync(path.join(__dirname, 'medi_topics_log.txt'), 'utf8').split(/\r?\n/)) {
      const parts = l.split('|');
      if (/제목변경/.test(parts[0] || '') && parts[1]) { const [a, b] = parts[1].split(' → '); if (a && b) renamedFrom[b.trim()] = a.trim(); continue; }
      const q = (l.match(/\[(MQ\d+)/) || [])[1];
      if (q && parts[2]) byTitle[parts[2].trim()] = q;
    }
  } catch {}
  return (entry, title) => {
    let n = entry && entry.q_no ? String(entry.q_no) : '';
    let t = String(title || '').trim();
    for (let i = 0; !n && t && i < 6; i++) { n = byTitle[t] || ''; t = renamedFrom[t] || ''; }
    return { q_no: n || null, question: (entry && entry.question) || (n ? bank[n] || '' : '') };
  };
}

function backupFile(fp) {
  const dir = path.join(path.dirname(fp), '_손보기_백업');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  fs.copyFileSync(fp, path.join(dir, stamp + '_' + path.basename(fp)));
}

// 제목·소제목 길이 기준 (공백 포함 글자 수)
const _c0 = (() => { try { return E.loadCfg(); } catch { return {}; } })();
const TITLE_MIN = _c0.titleMin || 20, TITLE_MAX = _c0.titleMax || 32, H2_MAX = 32;
const charLen = (s) => [...String(s || '').trim()].length;

// 글의 핵심 키워드: 질문표의 지역·진료과·진료항목 → 없으면 큐의 라벨/태그 첫 항목
function mainKeyword(cfg, entry, qNo) {
  if (entry && entry.region && entry.dept) return [entry.region, entry.dept, entry.item].filter(Boolean).join(' ');
  const first = Array.isArray(entry && entry.labels) ? entry.labels[0]
    : String((entry && entry.keywords) || '').split(',')[0];
  return first && String(first).trim() ? String(first).trim() : '';
}

// 최근 글 제목 (같은 채널 7건 + 다른 채널 각 3건) — 형식·어미가 겹치지 않게 비교용
function recentTitles(cfg, channel, selfKey) {
  const pick = (posts, n, ch) => (posts || [])
    .filter(p => p.status !== 'rejected')
    .map(p => ({ t: ch === 'homepage' ? (p.post && p.post.title) : p.title, k: ch === 'homepage' ? (p.post && p.post.slug) : p.file }))
    .filter(x => x.t && !(ch === channel && x.k === selfKey))
    .slice(-n).map(x => x.t);
  const src = {
    blogger: E.loadQueue(cfg).posts,
    tistory: E.loadQueueTistory(cfg).posts,
    homepage: SAFE.readJsonSafe(HP_QUEUE, { posts: [] }).posts,
  };
  const out = [];
  for (const ch of Object.keys(src)) out.push(...pick(src[ch], ch === channel ? 7 : 3, ch));
  return [...new Set(out)];
}

async function jobRetitle(channel, key) {
  const L = locatePost(channel, key);
  const old = L.title;
  const qi = questionIndex(L.cfg)(L.it, old);
  const question = qi.question || '';
  const keyword = mainKeyword(L.cfg, L.it, qi.q_no);
  const recent = recentTitles(L.cfg, channel, key);
  const bodyHtml = channel === 'homepage' ? (L.it.post.body || '') : L.html;
  const heads = [...bodyHtml.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)].map(m => m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  jlog(`[제목 다시] ${channel} · ${old}`);
  if (keyword) jlog(`  핵심 키워드: ${keyword}`);
  const prompt = [
    '너는 메세지 메디(messeze medi) 블로그 글의 제목만 다시 짓는다. 독자는 병원·의원 원장님과 병원 마케팅 담당자다(환자가 아니다).',
    question ? `선정 질문: "${question}"` : '',
    keyword ? `핵심 키워드: "${keyword}"` : '',
    `현재 제목: "${old}"`,
    heads.length ? `본문 소제목(h2) ${heads.length}개:\n` + heads.map((h, i) => `  ${i + 1}. ${h}`).join('\n') : '',
    recent.length ? `최근 다른 글 제목 ${recent.length}개 (이 제목들과 형식·어미·문장 틀이 겹치면 안 된다):\n` + recent.map(t => `  · ${t}`).join('\n') : '',
    '규칙:',
    `- ★길이: 공백 포함 ${TITLE_MIN}~${TITLE_MAX}자. ${TITLE_MAX}자를 넘기지 말 것 — 부제(— 뒤 설명)나 수식어를 덜어 짧게.`,
    keyword ? '- ★핵심 키워드(지역명·진료과·진료항목)를 제목 맨 앞에 그대로 둔다 — 순서를 바꾸거나 빼지 않는다.' : '- ★글의 핵심 키워드를 제목 맨 앞에 둔다.',
    '- ★최근 다른 글 제목과 같은 형식·어미·문장 틀 금지(예: 최근 글이 "~하는 이유"로 끝났으면 다른 형식으로). 현재 제목과도 다르게.',
    '  형식: 정리형(~순서/체크리스트) · 이유·원리형 · 비교형(A와 B의 차이) · 질문형(~해야 할까?) · 숫자형(~3가지) · 오해교정형(~의 오해와 실제).',
    '- 제목은 본문 내용과 어긋나면 안 된다. 숫자(~3가지 등)를 넣을 때는 본문에서 실제로 그 개수만큼 다루는 경우에만 — 확실하지 않으면 숫자형을 쓰지 말 것.',
    '- 질문(없으면 현재 제목)의 핵심 요지를 전문가 정보형 제목으로. 질문에 없는 요소를 덧붙이지도, 핵심을 빼지도 말 것.',
    '- 고객이 실제로 쓰는 말로: "GEO", "AEO", "생성형엔진최적화" 같은 업계 용어는 제목에 쓰지 않는다(챗GPT·AI 검색·검색에 안 나온다 등으로).',
    '- 광고 티·낚시성 과장·"보장/1위/무조건"·이모지·따옴표 금지. 치료 효과·후기·가격을 떠올리게 하는 표현 금지(의료광고 기준).',
    '- 다른 말·설명 없이 새 제목 한 줄만 출력.',
  ].filter(Boolean).join('\n');
  let t = '', feedback = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const raw = await E.runClaude(prompt + feedback, L.cfg, jlog);
    let c = String(raw).split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop() || '';
    c = c.replace(/^(새\s*)?제목\s*[:：]\s*/, '').replace(/["“”'‘’<>]/g, '').replace(/\s+/g, ' ').trim();
    if (/(까|나요|까요|가요|은가|는가|을까|할까|될까|인가|일까|어디|무엇|왜)$/.test(c)) c += '?';
    const n = charLen(c);
    const why = !c ? '빈 응답' : c === old ? '현재 제목과 같음' : recent.includes(c) ? '다른 글 제목과 같음'
      : n > TITLE_MAX ? `${n}자 — ${TITLE_MAX}자 초과` : n < TITLE_MIN ? `${n}자 — ${TITLE_MIN}자 미만` : '';
    if (!why) { t = c; break; }
    jlog(`  ${attempt}차 제목 탈락(${why}): ${c}`);
    feedback = `\n\n[다시] 직전 답 "${c}" 은(는) 기준에 맞지 않는다(${why}). 공백 포함 ${TITLE_MIN}~${TITLE_MAX}자로, 핵심 키워드는 맨 앞에 둔 채 다시 한 줄만 출력.`;
  }
  if (!t) throw new Error(`기준(${TITLE_MIN}~${TITLE_MAX}자)에 맞는 제목을 만들지 못했습니다 — 다시 눌러 주세요`);
  if (channel === 'homepage') {
    L.it.post.title = t;
    L.save();
    const dir = require('./medi-export').exportPost(L.it);
    if (dir) jlog('  파일 갱신: ' + dir);
  } else {
    backupFile(L.fp);
    fs.writeFileSync(L.fp, L.html.split(old).join(t), 'utf8');
    L.it.title = t;
    const copy = E.refreshOutputCopy(L.cfg, channel, key);
    if (copy) jlog('  보관 사본 갱신: ' + copy);
  }
  L.save();
  try { fs.appendFileSync(path.join(__dirname, 'medi_topics_log.txt'), `\n${channel}·제목변경·${E.today()}|${old} → ${t}\n`); } catch {}
  jlog(`  새 제목(${charLen(t)}자): ${t}`);
}

// 다른 원고·사이트에서 이미 쓴 이미지 URL (재사용 방지)
async function usedImageUrls(cfg) {
  const set = new Set();
  const dirs = [E.paths(cfg).posts, E.pathsTistory(cfg).posts];
  for (const d of dirs) { try { for (const f of fs.readdirSync(d)) { if (!/\.html$/.test(f)) continue; const h = fs.readFileSync(path.join(d, f), 'utf8'); for (const m of h.matchAll(/<img[^>]+src="([^"]+)"/g)) set.add(m[1]); } } catch {} }
  for (const it of SAFE.readJsonSafe(HP_QUEUE, { posts: [] }).posts || []) if (it.post && it.post.photo) set.add(it.post.photo);
  return set;
}

async function jobReplaceImages(channel, key, hint = '') {
  const L = locatePost(channel, key);
  const used = await usedImageUrls(L.cfg);
  const PICK = require('./image-pick');
  if (channel === 'homepage') {
    const p = L.it.post;
    jlog(`[이미지 교체] 홈페이지 커버 · ${p.title}`);
    if (p.photo) used.add(p.photo);
    // 최근 글 커버 (같은 장면 반복 방지용 비교 사진)
    const refs = (L.q.posts || []).filter(x => x.post && x.post.slug !== p.slug && x.post.photo && x.status !== 'rejected').slice(-4).map(x => x.post.photo);
    if (hint) jlog(`  원하는 장면: ${hint}`);
    const pick = await PICK.pickCover({ E, cfg: L.cfg, log: jlog, post: p, used, refs, hint });
    if (!pick) throw new Error('기준을 통과한 새 커버 사진을 찾지 못했습니다 — 다시 눌러 주세요');
    p.photo = pick.url; L.save();
    jlog(`  새 커버: ${pick.url}`);
    jlog(`  선택 이유: ${pick.reason}`);
    const dir = require('./medi-export').exportPost(L.it);
    if (dir) jlog('  파일 갱신: ' + dir);
    return;
  }
  const imgs = [...L.html.matchAll(/<img\b[^>]*>/g)].map(m => {
    const tag = m[0];
    // 이 사진이 속한 소제목 = 사진 앞에 나온 마지막 h2
    const heads = [...L.html.slice(0, m.index).matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)];
    const section = heads.length ? heads[heads.length - 1][1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
    return { tag, section, src: (tag.match(/src="([^"]+)"/) || [])[1] || '', alt: (tag.match(/alt="([^"]*)"/) || [])[1] || '' };
  }).filter(x => x.src);
  if (!imgs.length) throw new Error('이 글에는 이미지가 없습니다');
  jlog(`[이미지 교체] ${channel} · ${L.title} · 이미지 ${imgs.length}장`);
  imgs.forEach(x => used.add(x.src));
  if (hint) jlog(`  원하는 느낌: ${hint}`);
  const picks = await PICK.pickInline({ E, cfg: L.cfg, log: jlog, title: L.title, slots: imgs, used, hint });
  let html = L.html, changed = 0;
  picks.forEach((pick, i) => {
    if (!pick) { jlog(`  ${i + 1}번 자리: 기준을 통과한 새 사진 없음 — 기존 유지`); return; }
    const newTag = imgs[i].tag.split(imgs[i].src).join(pick.url).replace(/alt="[^"]*"/, m => pick.alt ? `alt="${pick.alt}"` : m);
    html = html.replace(imgs[i].tag, newTag).split(imgs[i].src).join(pick.url);
    if (pick.alt) jlog(`     새 alt: ${pick.alt}`);
    changed++;
    jlog(`  ${i + 1}번 교체: ${pick.url}`);
    jlog(`     선택 이유: ${pick.reason}`);
  });
  if (!changed) throw new Error('교체된 이미지가 없습니다 — 다시 눌러 주세요');
  backupFile(L.fp);
  fs.writeFileSync(L.fp, html, 'utf8');
  jlog(`  이미지 ${changed}/${imgs.length}장 교체 완료 (원본은 posts\_손보기_백업)`);
  const copy = E.refreshOutputCopy(L.cfg, channel, key);
  if (copy) jlog('  보관 사본 갱신: ' + copy);
}

function runJob(kind, fn) {
  if (JOB.running) return false;
  JOB.running = true; JOB.kind = kind; JOB.logs = []; JOB.startedAt = Date.now();
  fn().catch(e => jlog('잡 오류: ' + e.message)).finally(() => { JOB.running = false; });
  return true;
}

// ── 매일 자동 생성 스케줄러 (서버가 켜져 있는 동안 동작) ──
// autoTime(기본 07:30) 이후 아직 오늘 실행 이력이 없고 오늘 글이 없으면 자동 생성.
// 서버를 늦게 켜도 그 시점에 따라잡아 실행한다. 실패해도 같은 날 재시도는 수동(쿼터 보호).
function schedulerTick() {
  try {
    const cfg = E.loadCfg();
    if (!cfg.autoDaily || JOB.running) return;
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (hhmm < (cfg.autoTime || '07:30')) return;
    const st = loadAuto();
    if (st.lastRunDate === E.today()) return;
    const T = E.tcfg(cfg);
    const H = E.hcfg(cfg);
    const tistoryOn = !!(T.enabled && T.autoDaily !== false);
    const homeOn = !!(H.enabled && H.autoDaily !== false);
    const needBlogger = E.todayEntries(cfg).length < (cfg.postsPerRun || 3);
    const needTistory = tistoryOn && E.todayEntriesTistory(cfg).length < (T.postsPerRun || 3);
    const needHome = homeOn && E.todayEntriesHomepage(cfg).length < (H.postsPerRun || 1);
    if (!needBlogger && !needTistory && !needHome) { saveAuto({ ...st, lastRunDate: E.today(), note: '이미 존재' }); return; }
    saveAuto({ ...st, lastRunDate: E.today(), startedAt: new Date().toISOString() });
    jlog(`[자동] ${cfg.autoTime} 매일 자동 생성 트리거 (블로거${needBlogger ? ' 필요' : ' 있음'} · 티스토리${tistoryOn ? (needTistory ? ' 필요' : ' 있음') : ' 꺼짐'} · 홈페이지${homeOn ? (needHome ? ' 필요' : ' 있음') : ' 꺼짐'})`);
    runJob('자동 생성', async () => {
      if (needBlogger) await jobGenerate({});
      if (needTistory) await jobGenerateTistory({});
      if (needHome) await jobGenerateHomepage({});
    });
  } catch (e) { jlog('스케줄러 오류: ' + e.message); }
}
setInterval(schedulerTick, 30 * 1000);

async function state() {
  const cfg = E.loadCfg();
  const P = E.paths(cfg);
  const queue = (E.loadQueue(cfg).posts || []).slice().reverse().slice(0, 15);
  const scores = E.parseScores(cfg);
  const QI = questionIndex(cfg);
  for (const q of queue) { q.blogName = (cfg.blogs.find(b => q.blog_url && q.blog_url.startsWith(b.url.replace(/\/$/, ''))) || {}).name || ''; q.score = scores[q.title] ?? null; Object.assign(q, QI(q, q.title)); }
  const todayB = E.todayEntries(cfg);
  const blogList = (cfg.blogs || []).map(b => {
    const posts = todayB.filter(p => p.blog_url && p.blog_url.startsWith(b.url.replace(/\/$/, ''))).map(p => ({ ...p, score: scores[p.title] ?? null, ...QI(p, p.title) }));
    return { n: b.n, name: b.name, url: b.url, today: posts.length, posts };
  });
  let lastRun = null; try { lastRun = JSON.parse(fs.readFileSync(P.lastRun, 'utf8')); } catch {}
  let topicsTail = []; try { topicsTail = fs.readFileSync(P.topics, 'utf8').trim().split(/\r?\n/).slice(-8).reverse(); } catch {}
  let accounts = null; try { accounts = require('./accounts').list(); } catch {}
  let apiReady = false, apiHasSecret = false;
  try { const poster = require('./poster'); apiReady = poster.apiReady(); apiHasSecret = !!poster.findClientSecret(); } catch {}
  const auto = loadAuto();
  // ── 티스토리 채널 상태 ──
  const T = E.tcfg(cfg);
  let tistory = null;
  if (T.enabled) {
    const PT = E.pathsTistory(cfg);
    const sessionOk = fs.existsSync(path.join(T.sessionDir || '', 'auth.json'));
    // catsOk = 카테고리 id까지 추출됨(이름만 있는 프리시드 파일은 미완으로 본다)
    let catsOk = false;
    try { const c = JSON.parse(fs.readFileSync(PT.cats, 'utf8')); catsOk = Object.values(c).some(l => (l || []).some(x => x.id)); } catch {}
    const queueT = (E.loadQueueTistory(cfg).posts || []).slice().reverse().slice(0, 15);
    for (const q of queueT) { q.blogName = E.tistoryBlogName(cfg, q.account); q.score = scores[q.title] ?? null; Object.assign(q, QI(q, q.title)); }
    const todayT = E.todayEntriesTistory(cfg);
    const blogListT = (T.blogs || []).map(b => {
      const posts = todayT.filter(p => p.account === b.account).map(p => ({ ...p, score: scores[p.title] ?? null, ...QI(p, p.title) }));
      return { n: b.n, name: b.name, account: b.account, today: posts.length, posts };
    });
    let lastRunT = null; try { lastRunT = JSON.parse(fs.readFileSync(PT.lastRun, 'utf8')); } catch {}
    tistory = {
      enabled: true, sessionOk, catsOk,
      autoDaily: T.autoDaily !== false,
      todayCount: E.todayEntriesTistory(cfg).length, targetCount: T.postsPerRun || 3,
      stagger: T.publishStaggerMin ?? 5,
      queue: queueT, lastRun: lastRunT, blogList: blogListT,
    };
  }
  // ── 홈페이지 칼럼 채널 상태 ──
  const H = E.hcfg(cfg);
  let homepage = null;
  if (H.enabled) {
    const PH = E.pathsHomepage(cfg);
    const queueH = (E.loadQueueHomepage(cfg).posts || []).slice().reverse().slice(0, 15);
    for (const q of queueH) { q.blogName = '홈페이지'; q.score = scores[q.title] ?? null; const sl = q.slug || (q.post && q.post.slug) || ''; q.live_url = sl ? `https://messeze.com/blog/posts/${sl}.html` : ''; }
    let lastRunH = null; try { lastRunH = JSON.parse(fs.readFileSync(PH.lastRun, 'utf8')); } catch {}
    homepage = {
      enabled: true,
      autoDaily: H.autoDaily !== false,
      todayCount: E.todayEntriesHomepage(cfg).length, targetCount: H.postsPerRun || 1,
      outputDir: path.join(PH.outDir, E.today()),
      queue: queueH, lastRun: lastRunH,
    };
  }
  return {
    claude: !!E.CLAUDE, model: cfg.model, today: E.today(), apiReady, apiHasSecret,
    todayCount: E.todayEntries(cfg).length, targetCount: cfg.postsPerRun || 3,
    autoDaily: !!cfg.autoDaily, autoTime: cfg.autoTime || '07:30', autoLastRunDate: auto.lastRunDate || '',
    outputDir: path.join(cfg.outputDir, E.today()),
    queue, blogList, lastRun, topicsTail, accounts, tistory, homepage,
    version: UPD.localVersion(), update: UPD.lastCheck(),
    qLeft: (() => { try { const M = require('./medi-lib'); return { blogger: M.leftByBlog('blogger', cfg), tistory: M.leftByBlog('tistory', cfg) }; } catch { return null; } })(),
    job: { running: JOB.running, kind: JOB.kind, logs: JOB.logs.slice(-250), minutes: JOB.running ? Math.round((Date.now() - JOB.startedAt) / 60000) : 0 },
  };
}

function body(req) { return new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); }); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, obj, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
  try {
    if (url.pathname === '/') return send(200, fs.readFileSync(UI, 'utf8'), 'text/html; charset=utf-8');
    if (url.pathname === '/api/state') return send(200, await state());
    if (url.pathname === '/api/generate' && req.method === 'POST') {
      const b = await body(req);
      const label = b.only ? `블로거 ${b.only}번 블로그 1편 생성` : (b.force ? '생성(강제)' : '생성');
      if (!runJob(label, () => jobGenerate({ force: !!b.force, only: b.only ? Number(b.only) : 0 }))) return send(409, { ok: false, msg: '다른 작업 실행 중' });
      return send(200, { ok: true });
    }
    if (url.pathname === '/api/post' && req.method === 'POST') {
      const b = await body(req);
      const mode = b.mode === 'publish' ? 'publish' : 'draft';
      if (!runJob('게시(' + (mode === 'publish' ? '공개' : '초안') + ')', () => jobPost(mode, b.file))) return send(409, { ok: false, msg: '다른 작업 실행 중' });
      return send(200, { ok: true });
    }
    if (url.pathname === '/api/blogauth' && req.method === 'POST') {
      // 메세지 구글 계정 OAuth 1회 인증 — blogauth.js 실행(브라우저 동의 창이 열림)
      if (!runJob('구글 발행 인증', () => new Promise((resolve) => {
        const p = spawn('node', ['blogauth.js'], { cwd: __dirname });
        p.stdout.on('data', d => jlog(String(d).trim()));
        p.stderr.on('data', d => jlog(String(d).trim()));
        const to = setTimeout(() => { try { p.kill(); } catch {} jlog('인증 대기 시간 초과(5분) — 다시 시도하세요.'); resolve(); }, 5 * 60 * 1000);
        p.on('close', () => { clearTimeout(to); jlog('인증 절차 종료 — token.json ' + (fs.existsSync(path.join(__dirname, 'token.json')) ? '있음(연동 완료)' : '없음(미완료)')); resolve(); });
      }))) return send(409, { ok: false, msg: '다른 작업 실행 중' });
      return send(200, { ok: true, msg: '브라우저에서 메세지 구글 계정으로 동의를 완료하세요.' });
    }
    if (url.pathname === '/api/queue-status' && req.method === 'POST') {
      // 발행 후 상태 갱신: {file, status:"published", channel?:"tistory"}
      const b = await body(req);
      const cfg = E.loadCfg();
      const ch = b.channel === 'tistory' ? 'tistory' : (b.channel === 'homepage' ? 'homepage' : 'blogger');
      const q = ch === 'tistory' ? E.loadQueueTistory(cfg) : ch === 'homepage' ? E.loadQueueHomepage(cfg) : E.loadQueue(cfg);
      const it = (q.posts || []).find(p => p.file === b.file);
      if (!it) return send(404, { ok: false, msg: '해당 파일 없음' });
      if (ch === 'homepage') return send(400, { ok: false, msg: '홈페이지 칼럼은 홈페이지 칼럼 패널의 버튼으로 관리하세요.' });
      it.status = b.status === 'published' ? 'published' : 'pending';
      const qPath = ch === 'tistory' ? E.pathsTistory(cfg).queue : ch === 'homepage' ? E.pathsHomepage(cfg).queue : E.paths(cfg).queue;
      E.writeJsonSafe(qPath, q, { guardKey: 'posts' });
      jlog(`큐 상태 변경${ch !== 'blogger' ? `(${ch})` : ''}: ${b.file} → ${it.status}`);
      return send(200, { ok: true });
    }
    if (url.pathname === '/api/blogger-manual-published' && req.method === 'POST') {
      // 블로거에서 손으로 공개한 글을 '발행됨'으로 기록: {file, force?}
      // 블로거에 실제로 공개된 글을 찾아 주소·발행 시각까지 적는다. 못 찾으면 force 일 때만 주소 없이 표시.
      const b = await body(req);
      const cfg = E.loadCfg();
      const q = E.loadQueue(cfg);
      const it = (q.posts || []).find(p => p.file === b.file);
      if (!it) return send(404, { ok: false, msg: '해당 파일 없음' });
      if (it.status === 'published') return send(200, { ok: true, url: it.published_url || '' });
      let live = null, why = '';
      try {
        const poster = require('./poster');
        const blog = (cfg.blogs || []).find(x => it.blog_url && it.blog_url.startsWith(x.url.replace(/\/$/, '')));
        if (!poster.apiReady() || !blog || !blog.blogId) why = '블로거 API 연동이 안 되어 있어 공개 여부를 확인하지 못했습니다.';
        else {
          const api = poster.bloggerApi();
          if (it.post_id) {
            const r = await api.posts.get({ blogId: blog.blogId, postId: it.post_id, view: 'ADMIN' }).catch(() => null);
            if (r && r.data && r.data.status === 'LIVE') live = r.data;
          }
          if (!live) {
            // 초안을 쓰지 않고 새 글로 붙여 넣어 공개한 경우 — 최근 공개 글에서 슬러그·제목으로 찾는다
            const r = await api.posts.list({ blogId: blog.blogId, status: ['LIVE'], maxResults: 20, fetchBodies: false });
            live = ((r.data && r.data.items) || []).find(p => (it.slug && String(p.url || '').endsWith('/' + it.slug + '.html')) || p.title === it.title) || null;
          }
          if (!live) why = '블로거에서 이 글이 아직 공개 상태가 아닙니다(초안이거나 찾지 못함).';
        }
      } catch (e) { why = '블로거 확인 중 오류: ' + String(e.message || e).slice(0, 100); }
      if (!live && !b.force) return send(200, { ok: false, needConfirm: true, msg: why });
      it.status = 'published';
      it.manual = true;
      it.published_url = live ? (live.url || '') : (it.published_url || '');
      it.posted_at = live && live.published ? new Date(live.published).toISOString() : new Date().toISOString();
      if (live && live.id) it.post_id = live.id;
      E.writeJsonSafe(E.paths(cfg).queue, q, { guardKey: 'posts' });
      jlog(`수동 발행 완료 처리: ${b.file}${it.published_url ? ' | ' + it.published_url : ' (주소 확인 못 함)'}`);
      return send(200, { ok: true, url: it.published_url || '' });
    }
    // ── 티스토리 채널 ──
    if (url.pathname === '/api/regenerate' && req.method === 'POST') {
      // 큐 한 줄만 다시 쓰기: {channel:'blogger'|'tistory'|'homepage', file, mode:'same'|'new'}
      const b = await body(req);
      const channel = ['blogger', 'tistory', 'homepage'].includes(b.channel) ? b.channel : 'blogger';
      const mode = b.mode === 'new' ? 'new' : 'same';
      if (!b.file) return send(400, { ok: false, msg: '파일명이 없습니다' });
      // 실행 전에 대상 확인(에러를 UI에 바로 돌려준다)
      try {
        const cfg = E.loadCfg();
        const C = E.regenChannel(cfg, channel);
        const it = (C.queue.posts || []).find(p => p.file === b.file);
        if (!it) return send(404, { ok: false, msg: '큐에서 찾지 못했습니다' });
        if (it.status === 'published') return send(400, { ok: false, msg: '이미 발행된 글은 다시 생성할 수 없습니다' });
      } catch (e) { return send(500, { ok: false, msg: e.message }); }
      if (!runJob(`다시 생성(${channel})`, () => jobRegenerate(channel, b.file, mode))) return send(409, { ok: false, msg: '다른 작업 실행 중' });
      return send(200, { ok: true });
    }
    if (url.pathname === '/api/generate-tistory' && req.method === 'POST') {
      const b = await body(req);
      const label = b.only ? `티스토리 ${b.only}번 블로그 1편 생성` : (b.force ? '티스토리 생성(강제)' : '티스토리 생성');
      if (!runJob(label, () => jobGenerateTistory({ force: !!b.force, only: b.only ? Number(b.only) : 0 }))) return send(409, { ok: false, msg: '다른 작업 실행 중' });
      return send(200, { ok: true });
    }
    if (url.pathname === '/api/post-tistory' && req.method === 'POST') {
      const b = await body(req);
      const mode = ['draft', 'ptest', 'publish'].includes(b.mode) ? b.mode : 'draft';
      if (!runJob('티스토리 게시(' + (mode === 'publish' ? '공개' : mode === 'ptest' ? '비공개 테스트' : '초안') + ')', () => jobPostTistory(mode, b.file))) return send(409, { ok: false, msg: '다른 작업 실행 중' });
      return send(200, { ok: true });
    }
    if (url.pathname === '/api/tistory-login' && req.method === 'POST') {
      if (!runJob('티스토리 로그인', () => spawnJob('tistory-login.js', [], 10))) return send(409, { ok: false, msg: '다른 작업 실행 중' });
      return send(200, { ok: true, msg: '브라우저 창에서 카카오로 로그인하세요.' });
    }
    if (url.pathname === '/api/tistory-categories' && req.method === 'POST') {
      if (!runJob('티스토리 카테고리 추출', () => spawnJob('tistory-categories.js', [], 10))) return send(409, { ok: false, msg: '다른 작업 실행 중' });
      return send(200, { ok: true });
    }
    if (url.pathname === '/api/tistory-fixcat' && req.method === 'POST') {
      // 카테고리 추출 전에 발행돼 '카테고리 없음'으로 남은 글에 카테고리만 지정(본문은 건드리지 않음)
      const b = await body(req);
      if (!runJob('티스토리 카테고리 보정', () => spawnJob('tistory-fixcat.js', b.file ? [b.file] : [], 40))) return send(409, { ok: false, msg: '다른 작업 실행 중' });
      return send(200, { ok: true });
    }
    // ── 개별 글 손보기: 제목 다시 · 이미지 교체 (블로거·티스토리·홈페이지) ──
    if (url.pathname === '/api/retitle' && req.method === 'POST') {
      const b = await body(req);
      if (!runJob('제목 다시', () => jobRetitle(b.channel, b.file || b.slug))) return send(409, { ok: false, msg: '다른 작업 실행 중' });
      return send(200, { ok: true });
    }
    if (url.pathname === '/api/replace-images' && req.method === 'POST') {
      const b = await body(req);
      if (!runJob('이미지 교체', () => jobReplaceImages(b.channel, b.file || b.slug, String(b.hint || '').slice(0, 200)))) return send(409, { ok: false, msg: '다른 작업 실행 중' });
      return send(200, { ok: true });
    }
    // ── 메디 칼럼 (medi.messeze.com) — medi-gen.js 로 생성, medi-poster.js 로 관리자 화면에 저장 ──
    if (url.pathname === '/api/medi/state') {
      const M = require('./medi-lib');
      const q = M.loadQueue();
      const conf = M.loadConfig();
      const bank = M.loadBank(), used = M.usedQuestions();
      const left = {}; M.ALL_CATS.forEach(c => left[c] = 0);
      bank.filter(r => !used.has(r.no)).forEach(r => { left[r.cat] = (left[r.cat] || 0) + 1; });
      const sess = path.join(M.SESSION_DIR(), 'auth_medi.json');
      let mapOk = false; try { mapOk = !!JSON.parse(fs.readFileSync(path.join(M.SESSION_DIR(), 'medi-admin-map.json'), 'utf8')).newUrl; } catch {}
      return send(200, { queue: (q.posts || []).slice().reverse().slice(0, 15), availableCats: conf.availableCats, allCats: M.ALL_CATS, left, bankN: bank.length, loggedIn: fs.existsSync(sess), mapOk, lastSync: conf.lastSync, sheetUrl: conf.questionSheetUrl });
    }
    if (url.pathname === '/api/medi/sync-questions' && req.method === 'POST') {
      const M = require('./medi-lib');
      const r = await M.syncQuestions((m) => jlog('[메디 질문표] ' + m));
      return send(200, r.ok ? { ok: true, n: r.n } : { ok: false, msg: r.msg });
    }
    if (url.pathname === '/api/medi/generate' && req.method === 'POST') {
      if (!runJob('메디 칼럼 생성', () => spawnJob('medi-gen.js', [], 60))) return send(409, { ok: false, msg: '다른 작업 실행 중' });
      return send(200, { ok: true });
    }
    if (url.pathname === '/api/medi/regenerate' && req.method === 'POST') {
      const b = await body(req);
      if (!/^[a-z0-9-]+$/i.test(String(b.slug || ''))) return send(400, { ok: false, msg: 'slug 형식 오류' });
      const mode = b.mode === 'same' ? 'same' : 'new';
      if (!runJob(`메디 칼럼 다시 쓰기(${mode === 'same' ? '같은 질문' : '새 질문'})`, () => spawnJob('medi-gen.js', ['--regen=' + b.slug, '--mode=' + mode], 60))) return send(409, { ok: false, msg: '다른 작업 실행 중' });
      return send(200, { ok: true });
    }
    if (url.pathname === '/api/medi/publish' && req.method === 'POST') {
      const b = await body(req);
      if (!/^[a-z0-9-]+$/i.test(String(b.slug || ''))) return send(400, { ok: false, msg: 'slug 형식 오류' });
      const mode = b.mode === 'public' ? 'public' : 'private';
      const a = ['publish', '--slug=' + b.slug, '--mode=' + mode].concat(b.dry ? ['--dry'] : []);
      if (!runJob(`메디 ${mode === 'public' ? '공개 발행' : '관리자 비공개 저장'}${b.dry ? '(입력만)' : ''}`, () => spawnJob('medi-poster.js', a, 20))) return send(409, { ok: false, msg: '다른 작업 실행 중' });
      return send(200, { ok: true });
    }
    if (url.pathname === '/api/medi/login' && req.method === 'POST') {
      if (!runJob('메디 관리자 로그인', () => spawnJob('medi-login.js', [], 10))) return send(409, { ok: false, msg: '다른 작업 실행 중' });
      return send(200, { ok: true });
    }
    if (url.pathname === '/api/medi/reject' && req.method === 'POST') {
      const b = await body(req);
      const M = require('./medi-lib'); const q = M.loadQueue();
      const it = (q.posts || []).find(x => x.post && x.post.slug === b.slug && ['pending', 'error', 'saved_private'].includes(x.status));
      if (!it) return send(404, { ok: false, msg: '대기 글 없음' });
      const was = it.status; it.status = 'rejected'; M.saveQueue(q);
      jlog('메디 칼럼 반려: ' + it.post.title + (was === 'saved_private' ? ' (관리자에 저장된 비공개 글은 관리자 화면에서 직접 삭제하세요)' : ''));
      return send(200, { ok: true });
    }
    if (url.pathname === '/api/medi/config' && req.method === 'POST') {
      const b = await body(req);
      const M = require('./medi-lib');
      const cats = (Array.isArray(b.availableCats) ? b.availableCats : []).filter(c => M.ALL_CATS.includes(c));
      if (!cats.length) return send(400, { ok: false, msg: '분류를 하나 이상 선택하세요' });
      M.saveConfig({ availableCats: cats });
      return send(200, { ok: true });
    }
    if (url.pathname.startsWith('/medi-preview/') || url.pathname.startsWith('/medi-fields/')) {
      const M = require('./medi-lib');
      const isPrev = url.pathname.startsWith('/medi-preview/');
      const slug = decodeURIComponent(url.pathname.slice((isPrev ? '/medi-preview/' : '/medi-fields/').length));
      const it = (M.loadQueue().posts || []).find(x => x.post && x.post.slug === slug);
      if (!it) return send(404, '<h2>글을 찾을 수 없습니다</h2>', 'text/html; charset=utf-8');
      const X = require('./medi-export');
      return isPrev ? send(200, X.renderHtml(it), 'text/html; charset=utf-8') : send(200, X.fieldsTxt(it), 'text/plain; charset=utf-8');
    }
    // ── 원격 업데이트 (GitHub 저장소 → 이 PC) — updater.js ──
    if (url.pathname === '/api/update/check' && req.method === 'POST') {
      const r = await UPD.check();
      return send(200, r);
    }
    if (url.pathname === '/api/update/apply' && req.method === 'POST') {
      if (JOB.running) return send(409, { ok: false, msg: '다른 작업 실행 중 — 끝난 뒤 다시 눌러 주세요' });
      runJob('프로그램 업데이트', async () => {
        const r = await UPD.apply(jlog);
        if (!r.ok) { jlog('! 업데이트 실패: ' + (r.msg || '')); return; }
        if (!r.changed) { jlog('이미 최신 버전입니다.'); return; }
        jlog(`업데이트 완료 → v${r.version}. 대시보드를 다시 시작합니다(실행 창이 자동으로 다시 켭니다).`);
        setTimeout(() => process.exit(42), 1500);
      });
      return send(200, { ok: true });
    }
    // ── Claude 다계정 관리 ──
    if (url.pathname === '/api/account/switch' && req.method === 'POST') {
      const b = await body(req);
      const ok = require('./accounts').setActive(b.name);
      jlog(`계정 전환 → [${b.name}] ${ok ? 'OK' : '실패(없는 계정)'}`);
      return send(ok ? 200 : 400, { ok, msg: ok ? '' : '없는 계정' });
    }
    if (url.pathname === '/api/account/login' && req.method === 'POST') {
      const b = await body(req);
      const ACC = require('./accounts');
      const cur = await ACC.authStatus(b.name, E.CLAUDE, true);
      if (cur.loggedIn) return send(200, { ok: true, loggedIn: true, email: cur.email, subscriptionType: cur.subscriptionType });
      const r = await ACC.loginStart(b.name, E.CLAUDE);
      jlog(`계정 [${b.name}] 연동 시작 — 브라우저 로그인 URL ${r.url ? '발급' : '대기'}`);
      return send(r.ok || r.url ? 200 : 400, r);
    }
    if (url.pathname === '/api/account/code' && req.method === 'POST') {
      const b = await body(req);
      const r = await require('./accounts').loginCode(b.name, b.code, E.CLAUDE);
      if (r.loggedIn) jlog(`계정 [${b.name}] 연동 완료 — ${r.email || ''} (${r.subscriptionType || ''})`);
      return send(r.error ? 400 : 200, r);
    }
    if (url.pathname === '/api/account/logout' && req.method === 'POST') {
      const b = await body(req);
      const r = await require('./accounts').logout(b.name, E.CLAUDE, !!b.remove);
      jlog(`계정 [${b.name}] ${b.remove ? '삭제' : '로그아웃'} ${r.ok ? 'OK' : '실패'}`);
      return send(r.ok ? 200 : 400, r);
    }
    if (url.pathname === '/api/account/refresh' && req.method === 'POST') {
      const acc = await require('./accounts').refreshAll(E.CLAUDE);
      return send(200, { ok: true, accounts: acc });
    }
    if (url.pathname === '/api/account/test' && req.method === 'POST') {
      const b = await body(req);
      if (!runJob('계정 테스트(' + b.name + ')', () => require('./accounts').test(b.name, E.CLAUDE, E.loadCfg().model, jlog)))
        return send(409, { ok: false, msg: '다른 작업 실행 중' });
      return send(200, { ok: true });
    }
    if (url.pathname === '/raw') {
      // 수동 발행용 — 본문 HTML 원문을 그대로(text/plain) 보여준다. Ctrl+A → Ctrl+C 로 복사해
      // Blogger 글쓰기 화면의 [HTML 보기] 에 붙여넣으면 된다. (?f=파일명, 티스토리 원고도 가능)
      const cfg = E.loadCfg();
      const f = path.join(E.paths(cfg).posts, path.basename(url.searchParams.get('f') || ''));
      if (!fs.existsSync(f)) return send(404, '없음: ' + path.basename(f), 'text/plain; charset=utf-8');
      if (url.searchParams.get('dl')) {   // 파일로 내려받기(다운로드 폴더에 저장)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': `attachment; filename="${path.basename(f)}"` });
        return res.end(fs.readFileSync(f));
      }
      return send(200, fs.readFileSync(f, 'utf8'), 'text/plain; charset=utf-8');
    }
    if (url.pathname === '/api/open-in-editor' && req.method === 'POST') {
      // 원고 HTML 파일을 이 PC 의 VS Code 로 연다(없으면 메모장) — 코드를 보고 복사하는 용도
      const b = await body(req);
      const f = path.join(E.paths(E.loadCfg()).posts, path.basename(String(b.file || '')));
      if (!/\.html$/i.test(f) || !fs.existsSync(f)) return send(404, { ok: false, msg: '원고 파일이 없습니다' });
      const cands = [
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
        'C:\\Program Files\\Microsoft VS Code\\Code.exe',
        'C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe',
      ];
      const code = cands.find(p => { try { return fs.existsSync(p); } catch { return false; } });
      try {
        const p = spawn(code || 'notepad.exe', [f], { detached: true, stdio: 'ignore' });
        p.on('error', () => {}); p.unref();
      } catch (e) { return send(500, { ok: false, msg: e.message }); }
      return send(200, { ok: true, editor: code ? 'VS Code' : '메모장', path: f });
    }
    if (url.pathname.startsWith('/post-img/')) {
      // 원고에 넣은 로컬 사진(홈페이지 화면 캡처 등, posts\_img 폴더) — 미리보기용.
      // 티스토리 발행기는 이 주소(localhost:5012/post-img/파일명)를 로컬 파일로 읽어 티스토리에 업로드한다.
      const name = path.basename(decodeURIComponent(url.pathname.slice('/post-img/'.length)));
      const f = path.join(E.paths(E.loadCfg()).posts, '_img', name);
      if (!/\.(png|jpe?g|webp)$/i.test(name) || !fs.existsSync(f)) return send(404, '없음', 'text/plain; charset=utf-8');
      res.writeHead(200, { 'Content-Type': /\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : 'image/jpeg' });
      return res.end(fs.readFileSync(f));
    }
    if (url.pathname === '/preview') {
      const cfg = E.loadCfg();
      const f = path.join(E.paths(cfg).posts, path.basename(url.searchParams.get('f') || ''));
      if (!fs.existsSync(f)) return send(404, '없음', 'text/plain; charset=utf-8');
      return send(200, fs.readFileSync(f, 'utf8'), 'text/html; charset=utf-8');
    }
    if (url.pathname === '/publish-info') {
      const cfg = E.loadCfg();
      const f = path.join(cfg.outputDir, E.today(), '발행정보.txt');
      if (!fs.existsSync(f)) return send(404, '오늘 발행정보 없음 (생성 후 자동 생성됨)', 'text/plain; charset=utf-8');
      return send(200, fs.readFileSync(f, 'utf8'), 'text/plain; charset=utf-8');
    }
    if (url.pathname === '/publish-info-tistory') {
      const cfg = E.loadCfg();
      const f = path.join(E.pathsTistory(cfg).outDir, E.today(), '발행정보_티스토리.txt');
      if (!fs.existsSync(f)) return send(404, '오늘 티스토리 발행정보 없음 (생성 후 자동 생성됨)', 'text/plain; charset=utf-8');
      return send(200, fs.readFileSync(f, 'utf8'), 'text/plain; charset=utf-8');
    }
    send(404, { ok: false });
  } catch (e) { send(500, { ok: false, msg: e.message }); }
});

(async () => {
  const argv = process.argv.slice(2);
  if (argv[0] === '--batch') {
    console.log('배치 시작', E.today());
    try {
      const rep = await jobGenerate({});
      console.log('배치(블로거) 종료:', rep.skipped ? '건너뜀(이미 존재)' : `신규 ${rep.fresh.length}건`);
      const T = E.tcfg(E.loadCfg());
      if (T.enabled && T.autoDaily !== false) {
        const repT = await jobGenerateTistory({});
        console.log('배치(티스토리) 종료:', repT.skipped ? '건너뜀' : `신규 ${repT.fresh.length}건`);
      }
      const H = E.hcfg(E.loadCfg());
      if (H.enabled && H.autoDaily !== false) {
        const repH = await jobGenerateHomepage({});
        console.log('배치(홈페이지) 종료:', repH.skipped ? '건너뜀' : `신규 ${repH.fresh.length}건`);
      }
      process.exit(0);
    } catch (e) { console.error('배치 실패:', e.message); process.exit(2); }
  }
  // 첫 실행: 필요한 폴더·빈 큐 파일을 만든다
  for (const d of ['posts', 'data', 'tmp', '_img_check']) { try { fs.mkdirSync(path.join(__dirname, d), { recursive: true }); } catch {} }
  for (const f of ['queue.json', 'queue_tistory.json', 'queue_medi.json']) { const p = path.join(__dirname, f); if (!fs.existsSync(p)) { try { fs.writeFileSync(p, '{"posts":[]}', 'utf8'); } catch {} } }
  for (const f of ['medi_topics_log.txt', 'medi_column_topics_log.txt']) { const p = path.join(__dirname, f); if (!fs.existsSync(p)) { try { fs.writeFileSync(p, '', 'utf8'); } catch {} } }
  const port = E.loadCfg().port || 5015;
  SAFE.installServerErrorHandler(server, port, '메디 대시보드');
  server.listen(port, '127.0.0.1', () => console.log(`messeze-medi-auto v${UPD.localVersion()}: http://127.0.0.1:${port}  (claude: ${E.CLAUDE ? 'OK' : '없음'})`));
  if ((E.loadCfg().update || {}).checkOnStart !== false) UPD.check().catch(() => {});
  try { require('./accounts').refreshAll(E.CLAUDE).catch(() => {}); } catch {}
})();
