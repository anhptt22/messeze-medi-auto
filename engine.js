// engine.js — messeze-medi-auto 코어 (메세지 본 프로그램 messeze-auto 2026-11-09판 엔진을 메디 전용으로 옮긴 것)
// 방식: prompts/ 의 채널별 프롬프트 전체를 claude -p 에이전트에게 주고,
//       에이전트가 직접 주제 선정(topics_log 중복 회피)·이미지 선별(드라이브 메일리 사진)·
//       FAQ(질문 은행)·글 3편 작성·queue.json 적재·topics_log 기록까지 수행한다.
//       (윈차이나식 JS 오케스트레이션과 달리 프롬프트가 전 과정을 담당 — 2026-08-12 확정 구조)
// 서버(writer.js)는: 실행 전 스냅샷 → claude 실행(다계정 페일오버) → 실행 후 검증(QA)·
//       채점 파싱·output\<채널>\<날짜>\ 보관본 + 발행정보.txt 생성까지 담당.
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const https = require('https');
const http = require('http');
const ACC = require('./accounts'); // Claude 다계정 전환/페일오버 (윈차이나와 동일 모듈, 프로그램 폴더 안 claude-accounts)

const CFG_FILE = path.join(__dirname, 'writer_config.json');

// \uC548\uC804\uD55C JSON \uC77D\uAE30\u00B7\uC4F0\uAE30 (BOM \uC81C\uAC70\u00B7\uBC31\uC5C5 \uBCF5\uAD6C\u00B7\uC6D0\uC790\uC801 \uC800\uC7A5) \u2014 safe-json.js \uCC38\uACE0
const { readJsonSafe, writeJsonSafe } = require('./safe-json');

// 설정 = writer_config.json(저장소 기본값) + writer_config.local.json(이 PC 덮어쓰기). 경로는 프로그램 폴더 기준으로 풀린다 — config.js
function loadCfg() { return require('./config').load(); }

// ── claude.exe 탐지 (윈차이나판과 동일) ──────────────────
function findClaude() {
  const cands = [];
  const push = (p) => { try { if (p && fs.existsSync(p)) cands.push(p); } catch {} };
  try { push(execSync('where claude', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).split(/\r?\n/)[0].trim()); } catch {}
  push(path.join(process.env.USERPROFILE || '', '.local', 'bin', 'claude.exe'));
  push(path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'));
  // 데스크톱 앱에 딸린 claude-code: <버전>\claude.exe (구) 또는 <버전>\<해시>\claude.exe (2.1.286~, 앱 업데이트로 한 단계 깊어짐)
  const scanVersions = (cc) => {
    try {
      const vers = fs.readdirSync(cc).filter(v => /^\d/.test(v)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const v of vers) {
        push(path.join(cc, v, 'claude.exe'));
        try { for (const sub of fs.readdirSync(path.join(cc, v))) push(path.join(cc, v, sub, 'claude.exe')); } catch {}
      }
    } catch {}
  };
  const pkgRoot = path.join(process.env.LOCALAPPDATA || '', 'Packages');
  try {
    for (const d of fs.readdirSync(pkgRoot).filter(n => n.startsWith('Claude_'))) scanVersions(path.join(pkgRoot, d, 'LocalCache', 'Roaming', 'Claude', 'claude-code'));
  } catch {}
  scanVersions(path.join(process.env.APPDATA || '', 'Claude', 'claude-code'));
  // 데스크톱 앱 4.4212 부터(2026-11) 데이터가 %LOCALAPPDATA%\Claude-Data\claude_<id>\claude-code\<버전>\<해시>\claude.exe 로 옮겨졌다
  try {
    const cd = path.join(process.env.LOCALAPPDATA || '', 'Claude-Data');
    for (const d of fs.readdirSync(cd)) scanVersions(path.join(cd, d, 'claude-code'));
  } catch {}
  return cands[0] || null;
}
const CLAUDE = findClaude();

function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function todayCompact() { return today().replace(/-/g, ''); }

function paths(cfg) {
  const base = cfg.baseDir || __dirname;
  return {
    base,
    posts: path.join(base, 'posts'),
    queue: path.join(base, 'queue.json'),
    topics: path.join(base, 'medi_topics_log.txt'),
    lastRun: path.join(base, '_last_run.json'),
    autoState: path.join(base, '_auto_state.json'),
  };
}
function loadQueue(cfg) {
  return readJsonSafe(paths(cfg).queue, { posts: [] });
}
function todayEntries(cfg) {
  const pref = 'medi_post' + todayCompact() + '_';
  return (loadQueue(cfg).posts || []).filter(p => (p.file || '').startsWith(pref));
}

// ── claude -p 1회 실행 (윈차이나 spawnClaudeOnce 패턴 + 에이전트용 도구 허용) ──
function spawnClaudeOnce(prompt, cfg, env, log) {
  const args = ['-p', '--model', cfg.model || 'opus', '--allowedTools', cfg.allowedTools || 'Read,Write,WebSearch,WebFetch,Bash'];
  return new Promise((resolve, reject) => {
    const p = spawn(CLAUDE, args, { windowsHide: true, env, cwd: cfg.baseDir || __dirname });
    let out = '', err = '';
    const to = setTimeout(() => { try { p.kill(); } catch {} reject(new Error(`claude 시간 초과(${cfg.claudeTimeoutSec || 3600}초)`)); }, (cfg.claudeTimeoutSec || 3600) * 1000);
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { clearTimeout(to); reject(e); });
    p.on('close', (code) => {
      clearTimeout(to);
      const c = out + '\n' + err;
      if (/Not logged in|Please run \/login/i.test(c)) return reject(new Error('Not logged in (login 필요)'));
      if (ACC.isSwitchable(c) && (code !== 0 || out.trim().length < 300))
        { const flat = c.replace(/\s+/g, ' ').trim(); const rs = (flat.match(/resets\s+[^·\n]{1,60}?(\([^)]+\)|(?:am|pm)\b)/i) || [''])[0];
          let msg = flat.slice(0, 140); if (rs && !msg.includes(rs)) msg += ' · ' + rs;   // 재개 시각이 잘리지 않게
          return reject(new Error('usage limit: ' + msg)); }
      if (!out.trim()) return reject(new Error('claude 빈 응답 ' + err.slice(0, 150)));
      resolve(out.trim());
    });
    p.stdin.write(prompt); p.stdin.end();
  });
}

// ── 다계정 자동 페일오버 (윈차이나 runClaude와 동일 로직) ──
async function runClaude(prompt, cfg, log) {
  if (!CLAUDE) return Promise.reject(new Error('claude 실행파일을 찾지 못했습니다.'));
  const tried = new Set();
  let name = ACC.activeName();
  let lastErr;
  for (let i = 0; i < 8; i++) {
    tried.add(name);
    log && log(`  claude 실행 (${cfg.model}) · 계정 [${name}] · 최대 ${Math.round((cfg.claudeTimeoutSec || 3600) / 60)}분 ...`);
    try {
      return await spawnClaudeOnce(prompt, cfg, ACC.envFor(name), log);
    } catch (e) {
      lastErr = e;
      if (!ACC.isSwitchable(e.message)) throw e;
      { const until = ACC.cooldownMsFromMsg ? ACC.cooldownMsFromMsg(e.message) : null;
        ACC.markCooldown(name, until || (/weekly/i.test(e.message) ? 12 * 3600 * 1000 : undefined));
        if (until) log && log(`  계정 [${name}] 한도 재개 예정: ${new Date(Date.now() + until).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`); }
      const next = ACC.nextHealthy(name);
      log && log(`  ! 계정 [${name}] 사용 불가(${e.message.slice(0, 45)}) → ${next ? `계정 [${next}]로 전환` : '전환할 계정 없음'}`);
      if (!next || tried.has(next)) throw new Error(`모든 계정 소진/미로그인: ${e.message.slice(0, 80)}`);
      ACC.setActive(next);
      name = next;
    }
  }
  throw lastErr || new Error('claude 호출 실패');
}

// ── 질문 배정 블록: 프로그램(medi-lib.planFor)이 질문표에서 고른 질문을 블로그별로 적어 준다 ──
function planBlock(plan, channel) {
  if (!plan || !plan.length) return '- ★질문 배정 없음 — 질문표에서 쓸 수 있는 질문을 찾지 못했다. 글을 쓰지 말고 "질문 없음"만 출력한다.';
  const L = ['- ★★이번 실행의 질문 배정 (프로그램이 질문표에서 골랐다 — 질문을 스스로 고르거나 바꾸지 않는다. 아래 블로그마다 정확히 1편):'];
  for (const it of plan) {
    const r = it.row, b = it.blog;
    L.push(`  · ${b.n}번 블로그 「${b.name}」(${channel === 'tistory' ? 'account: ' + b.account : b.url}) → **${r.no}** "${r.q}" (지역 ${r.region} · 진료과 ${r.dept} · 진료항목 ${r.item} · 고민 유형 ${r.concern})`
      + (r.variant ? ` ★질문표 원문(${r.origDept}·${r.origItem})을 ${r.variant} 각도로 바꾼 질문이다 — ${r.variant} 상황에 맞게 쓰고, 어색한 낱말(환자 → 보호자·반려동물 등)은 자연스럽게 고친다` : '')
      + (it.recycled ? ' ★이 채널에서 전에 쓴 적 있는 질문이다 — 이전 글과 다른 각도·다른 소제목·다른 제목으로 쓴다' : ''));
  }
  L.push('- ★큐 항목마다 "q_no": "[위 MQ번호]", "question": "[위 질문 그대로]" 두 필드를 반드시 추가한다. topics_log 줄에도 [MQ번호] 를 적는다.');
  return L.join('\n');
}

// ── 실행 프롬프트 = 엔진 프롬프트(매번 새로 읽음) + 자동 주입 블록 ──
function buildRunPrompt(cfg, opts = {}) {
  const enginePrompt = fs.readFileSync(cfg.enginePrompt, 'utf8');
  const P = paths(cfg);
  const pref = 'medi_post' + todayCompact() + '_';
  let existing = [];
  try { existing = fs.readdirSync(P.posts).filter(f => f.startsWith(pref)); } catch {}
  const startN = existing.length + 1;
  const only = opts.only ? (cfg.blogs || []).find(b => b.n === Number(opts.only)) : null;
  const count = opts.plan ? opts.plan.length : (only ? 1 : (cfg.postsPerRun || 5));
  const nList = Array.from({ length: count }, (_, i) => startN + i);
  return enginePrompt + `

## ■ [자동 주입 — 이번 실행 정보 (서버가 삽입, 프롬프트 본문보다 우선)]
${banPromptBlock(cfg)}
- 오늘 날짜: ${today()} (파일명 날짜부: ${todayCompact()})
- 이번 실행에서 저장할 파일명: ${nList.map(n => `medi_post${todayCompact()}_${n}.html`).join(' · ')} (n=${nList.join(',')} — 기존 파일 덮어쓰기 절대 금지)
${existing.length ? `- ★오늘 이미 작성된 파일 ${existing.length}건 존재(${existing.join(', ')}) — 그 글들과 주제·질문이 겹치면 안 된다.` : ''}
- 작업 폴더: ${P.base} (posts\\ · queue.json · medi_topics_log.txt 모두 이 안)
${only ? `- ★★이번 실행은 ${only.n}번 블로그 「${only.name}」(${only.url}) 에 쓸 글 1편만 작성한다 — 프롬프트 본문의 "블로그마다 1편" 지시보다 이 줄이 우선. blog_url 은 ${only.url}. 이 블로그의 진료과 각도를 따른다.` : ''}
- queue.json 은 기존 항목을 절대 삭제·수정하지 말고 ${count}개 항목만 append. slug 는 기존 항목들과 중복 금지.
${planBlock(opts.plan, 'blogger')}
- 보관 폴더(output)의 날짜 폴더와 발행정보.txt 는 서버가 실행 후 자동 생성하므로 만들지 않는다.
- 완료 후 마지막 출력: "${count}개 작성 완료" + 제목 ${count}개 목록.`;
}

// 제목·소제목 길이 점검 (공백 포함 글자 수) — 제목 20~32자, h2 소제목 32자 이내
function lengthWarns(title, html) {
  const out = [];
  const len = (x) => [...String(x || '').trim()].length;
  const n = len(title);
  let tMin = 20, tMax = 32; try { const c = loadCfg(); tMin = c.titleMin || tMin; tMax = c.titleMax || tMax; } catch {}
  if (n > tMax) out.push(`제목 ${n}자(${tMax}자 초과)`);
  else if (n && n < tMin) out.push(`제목 ${n}자(${tMin}자 미만)`);
  const long = [...String(html || '').matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)]
    .map(m => m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
    .filter(h => len(h) > 32);
  if (long.length) out.push(`소제목 ${long.length}개 32자 초과(${long.map(h => len(h) + '자').join(',')})`);
  return out;
}

// SUMMARY 박스 점검 — 줄 수 = 본문 섹션 수, 한 줄 55자 이내, "핵심어 — 결론" 형식
// ── 인사 뒤 도입 문단 확인 (2026-10-07: 블로거 5건 전부 인사 한 줄만 있었음) ──
function introWarns(html) {
  const s = String(html || '');
  const i = s.indexOf('안녕하세요');
  if (i < 0) return ['인사("안녕하세요, 메세지 메디입니다.") 없음'];
  const j = s.indexOf('<h2', i);
  if (j < 0) return [];
  const t = s.slice(i, j).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/안녕하세요,?\s*메세지\s*(AI\s*)?(메디)?\s*입니다\.?/, '').trim();
  const n = [...t].length;
  return n < 80 ? [`인사 뒤 도입 문단 ${n}자(3~4문장 150~250자 필요 — 인사만 쓰고 POINT 01 로 넘어감)`] : [];
}
function summaryWarns(html) {
  const out = [];
  const s = String(html || '');
  const i = s.indexOf('SUMMARY');
  if (i < 0) return out;
  const start = s.indexOf('<table', i);
  const end = start < 0 ? -1 : s.indexOf('</table>', start);
  if (start < 0 || end < 0) return out;
  const text = (x) => x.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const rows = [...s.slice(start, end).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map(m => text(m[1]).replace(/^[①②③④⑤]\s*/, '')).filter(Boolean);
  const sections = [...s.matchAll(/<h2[\s>][\s\S]*?<\/h2>/gi)].map(m => text(m[0])).filter(h => !/자주 묻는 질문/.test(h)).length;
  if (rows.length && sections && rows.length !== sections) out.push(`SUMMARY ${rows.length}줄 ≠ 본문 섹션 ${sections}개`);
  const long = rows.filter(r => [...r].length > 55);
  if (long.length) out.push(`SUMMARY ${long.length}줄 55자 초과(${long.map(r => [...r].length + '자').join(',')})`);
  const noKey = rows.filter(r => !/^.{2,12}\s[—–-]\s/.test(r));
  if (noKey.length) out.push(`SUMMARY ${noKey.length}줄 "핵심어 — 결론" 형식 아님`);
  return out;
}

// ── HTML QA (파이프라인 check.py와 동일 기준 + 추가 검증) ──
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
// 자사·자기채널 호스트(외부 공식출처로 세지 않음). ★developers.google.com(구글 검색 센트럴) 같은
// 공식 기술문서는 정당한 외부 출처이므로 제외하지 않는다 — 구글 검색 결과 페이지만 뺀다.
const SELF_HOSTS = /(?:^|\.)(messeze\.com|tistory\.com|blogspot\.com|blogger\.com|googleusercontent\.com|kakao\.com)$/i;
const isSelfHost = (h) => SELF_HOSTS.test(h) || h === 'google.com' || h === 'www.google.com';
function qaCheckHtml(html) {
  const issues = [], warns = [];
  const body = html.replace(/<script[\s\S]*?<\/script>/g, '');
  const text = body.replace(/<[^>]+>/g, '');
  const noSpace = text.replace(/\s/g, '');
  if (/<h1/i.test(html)) issues.push('h1 존재');
  if (/<!DOCTYPE|<html|<head|<body/i.test(html)) issues.push('문서 래퍼 존재');
  if (EMOJI_RE.test(html)) issues.push('이모지 존재');
  if (/<style/i.test(html)) issues.push('<style> 존재');
  if (/display:\s*flex/i.test(html)) issues.push('display:flex 존재');
  const scripts = (html.match(/<script/g) || []).length;
  if (scripts !== 1) issues.push(`script ${scripts}개(1개여야 함)`);
  let faqN = 0;
  const mj = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!mj) issues.push('FAQ 스키마 없음');
  else {
    try { JSON.parse(mj[1]); faqN = (mj[1].match(/"@type":\s*"Question"/g) || []).length; if (faqN !== 5) warns.push(`스키마 Question ${faqN}개(5개 권장)`); }
    catch { issues.push('스키마 JSON 파싱 실패'); }
  }
  const opens = (html.match(/<table/g) || []).length, closes = (html.match(/<\/table>/g) || []).length;
  if (opens !== closes) issues.push(`table 짝 불일치 ${opens}/${closes}`);
  const imgs = [...html.matchAll(/<img [^>]*src="([^"]+)"/g)].map(m => m[1]);
  if (!imgs.length) warns.push('이미지 0장');
  if (imgs.some(u => /^data:/i.test(u))) issues.push('data URI 이미지 존재(금지)');
  // 공식 외부링크 수(자사·블로그 계열 제외 고유 호스트) — 2026-08-12 규칙: 2개/글
  const hosts = new Set();
  for (const m of body.matchAll(/<a href="https?:\/\/([^/"]+)/g)) {
    const h = m[1].toLowerCase();
    if (!isSelfHost(h)) hosts.add(h.replace(/^www\./, ''));
  }
  if (hosts.size < 2) warns.push(`공식 외부링크 ${hosts.size}개(2개 필요: ${[...hosts].join(',') || '없음'})`);
  return { issues, warns, chars: noSpace.length, imgs, faqN, officialHosts: [...hosts] };
}

// ── 이미지 URL 접근 확인 (리다이렉트 1회 추적, 실패=경고) ──
function checkUrl(u, redirects = 2) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const mod = u.startsWith('https') ? https : http;
      const req = mod.get(u, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        const sc = res.statusCode || 0;
        res.destroy();
        if ([301, 302, 303, 307, 308].includes(sc) && res.headers.location && redirects > 0)
          return checkUrl(new URL(res.headers.location, u).href, redirects - 1).then(fin);
        fin(sc >= 200 && sc < 400);
      });
      req.on('timeout', () => { req.destroy(); fin(false); });
      req.on('error', () => fin(false));
    } catch { fin(false); }
  });
}

// ── topics_log에서 오늘 채점 파싱 ──
function parseScores(cfg) {
  const map = {};
  try {
    // 줄 형식: "2026-10-07|블로그|제목|[Q#n]|채점 19/20" (블로거) · "티스토리·2026-10-07|…|채점 19/20" · "홈페이지·2026-10-07|…|19/20"
    //   → 채널 접두어를 떼고 오늘 날짜 줄만 읽는다. 점수는 "채점" 없이 "19/20"만 적힌 줄도 인식.
    const lines = fs.readFileSync(paths(cfg).topics, 'utf8').split(/\r?\n/).filter(l => l.replace(/^(티스토리|홈페이지|메디)·/, '').startsWith(today()));
    for (const l of lines) {
      const parts = l.split('|');
      const title = (parts[2] || '').trim();
      const ms = l.match(/(?:채점\s*)?(\d{1,2})\s*\/\s*20\b/);
      if (title) map[title] = ms ? +ms[1] : null;
    }
  } catch {}
  return map;
}

// ── 발행정보.txt 생성 + 날짜 보관 폴더 (2026-08-12 사용자 지정 구조) ──
function blogNameOf(cfg, url) {
  const b = (cfg.blogs || []).find(x => url && url.startsWith(x.url.replace(/\/$/, '')));
  return b ? b.name : '';
}
function publishInfoText(cfg, entries) {
  const L = [];
  L.push(`[블로거 발행 정보] 메세지 메디 블로그 — ${today()}`);
  L.push('');
  L.push('※ 발행 전 필수: 각 블로그 설정 > 메타 태그 > "검색 설명 사용" 토글 ON (켜야 글별 검색 설명 입력칸이 생김)');
  L.push('※ 본문 HTML은 Blogger 글쓰기 화면에서 HTML 모드로 붙여넣기 (파일은 본문 전용 조각, 제목은 제목칸에 따로 입력)');
  L.push('※ 이미지·스키마(FAQPage)는 본문에 이미 포함 — 발행 후 글 페이지 Ctrl+U → "FAQPage" 검색으로 확인');
  L.push('');
  entries.forEach((p, i) => {
    const host = (p.blog_url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    L.push('━'.repeat(34));
    L.push(`■ ${i + 1}번 글 → ${host.split('.')[0]} (${blogNameOf(cfg, p.blog_url)})`);
    L.push('━'.repeat(34));
    L.push(`파일: ${p.file}`);
    L.push(`발행 블로그: ${p.blog_url}`);
    L.push('');
    L.push('제목:');
    L.push(p.title || '');
    L.push('');
    L.push('라벨(쉼표로 입력):');
    L.push((p.labels || []).join(', '));
    L.push('');
    L.push('영문 슬러그(링크 > 맞춤 퍼머링크):');
    L.push(p.slug || '');
    L.push('');
    L.push('검색 설명:');
    L.push(p.meta_description || '');
    L.push('');
  });
  L.push('━'.repeat(34));
  L.push('■ 발행 후 공통 체크');
  L.push('━'.repeat(34));
  L.push('1. 글 주소가 슬러그대로 나왔는지 확인 (blogspot.com/YYYY/MM/슬러그.html)');
  L.push('2. Ctrl+U → "FAQPage" 검색 → 스키마 포함 확인');
  L.push('3. 첫 글 발행 후 Search Console에 sitemap.xml 제출 (블로그별 1회)');
  L.push('4. queue.json 해당 글 status를 pending → published로 변경');
  return L.join('\n') + '\n';
}
function buildOutputFolder(cfg, entries, log) {
  const dir = path.join(cfg.outputDir, today());
  fs.mkdirSync(dir, { recursive: true });
  const P = paths(cfg);
  for (const p of entries) {
    const src = path.join(P.posts, p.file);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, p.file));
  }
  fs.writeFileSync(path.join(dir, '발행정보.txt'), publishInfoText(cfg, entries), 'utf8');
  log && log(`  보관 폴더 갱신: ${dir} (글 ${entries.length}건 + 발행정보.txt)`);
  return dir;
}

// ── 질문형 제목은 물음표로 끝낸다 ("~날 수 있을까" → "~날 수 있을까?") ──
function questionTitle(t) {
  const s = String(t || '').trim();
  if (!s || /[?？]$/.test(s)) return s;
  return /(까|까요|나요|가요|은가|는가|인가|던가|어디|무엇|왜|어떻게|얼마|언제|누구)$/.test(s) ? s + '?' : s;
}
// 큐의 글 제목 중 질문형인데 물음표가 없는 것을 고친다 (원고 파일·큐·topics_log 를 함께 맞춘다).
// pick(p) 가 true 인 글만 대상. 발행된 글은 건드리지 않는다.
function fixQuestionTitles(cfg, channel, pick, log) {
  let changed = 0;
  try {
    const isT = channel === 'tistory';
    const P = isT ? pathsTistory(cfg) : paths(cfg);
    const q = isT ? loadQueueTistory(cfg) : loadQueue(cfg);
    for (const p of (q.posts || [])) {
      if (!p || !p.file || p.status === 'published' || !pick(p)) continue;
      const old = String(p.title || '');
      const nt = questionTitle(old);
      if (!old || nt === old) continue;
      const fp = path.join(P.posts, path.basename(p.file));
      try { if (fs.existsSync(fp)) { const h = fs.readFileSync(fp, 'utf8'); if (h.includes(old)) fs.writeFileSync(fp, h.split(old).join(nt), 'utf8'); } } catch {}
      replaceTitleInTopics(cfg, old, nt);
      p.title = nt; changed++;
      log && log(`  질문형 제목에 물음표 추가: ${nt}`);
    }
    if (changed) writeJsonSafe(P.queue, q, { guardKey: 'posts' });
  } catch (e) { log && log('  제목 물음표 정리 오류: ' + e.message); }
  return changed;
}
function replaceTitleInTopics(cfg, old, nt) {
  try {
    const tf = paths(cfg).topics;
    const t = fs.readFileSync(tf, 'utf8');
    // 줄 안에서 |제목| 으로 들어간 자리만 바꾼다 (이미 물음표가 붙은 줄은 그대로)
    const out = t.split('|' + old + '|').join('|' + nt + '|');
    if (out !== t) fs.writeFileSync(tf, out, 'utf8');
  } catch {}
}

// 새로 쓴 원고의 본문 사진: 주소를 가로 3:2 자르기 형식으로 통일(여백 큰 세로 사진 방지) + 장수 점검(권장 2~3장)
async function fixInlineImages(fp, r, log, cfg) {
  try {
    const PICK = require('./image-pick');
    const src = fs.readFileSync(fp, 'utf8');
    // 2026-10-13: 세로 사진은 Claude 가 피사체 위치를 보고 틀을 정한다(가로 사진은 기존 3:2 entropy)
    const { html, n } = await PICK.normalizeInline(src, { E: { runClaude }, cfg, log });
    if (n) { fs.writeFileSync(fp, html, 'utf8'); log && log(`  본문 사진 ${n}장 자르기 적용(가로 3:2 · 세로는 피사체 맞춤): ${path.basename(fp)}`); }
    const cnt = (html.match(/<img\b/gi) || []).length;
    if (cnt > 3) r.warns.push(`이미지 ${cnt}장(권장 2~3장 — 내용과 맞지 않는 사진은 빼세요)`);
    // 첫 사진이 POINT 01(첫 h2~두 번째 h2 사이)에 없으면 블로거·티스토리 목록 썸네일이 안 생긴다 (2026-10-03 확인)
    if (cnt) {
      const firstImg = html.search(/<img\b/i);
      const h2s = [...html.matchAll(/<h2\b/gi)].map(m => m.index);
      if (h2s.length >= 2 && (firstImg < h2s[0] || firstImg > h2s[1])) r.warns.push('첫 사진이 POINT 01 밖에 있음 — 목록 썸네일이 안 생깁니다. [이미지 교체]가 아니라 사진 블록을 POINT 01 로 옮기세요');
    }
  } catch (e) { log && log('  사진 주소 정리 오류: ' + e.message); }
}

// ── 같은 블로그 안 사진 중복 검사 (2026-10-13: 바우처통 두 글의 목록 썸네일이 같은 사진이었음) ──
function firstImageBase(html) {
  const m = String(html || '').match(/<img\b[^>]*?\bsrc="([^"]+)"/i);
  return m ? m[1].replace(/&amp;/g, '&').split('?')[0] : '';
}
function allImageBases(html) {
  return [...String(html || '').matchAll(/<img\b[^>]*?\bsrc="([^"]+)"/gi)].map(m => m[1].replace(/&amp;/g, '&').split('?')[0]).filter(Boolean);
}
// others: 같은 블로그의 다른 글 [{file, html}] (최근 15편) — 첫 사진이 같으면 '썸네일 중복', 본문 어딘가 같으면 '사진 중복'
function dupImageWarns(html, others) {
  const out = [];
  const first = firstImageBase(html);
  const mine = new Set(allImageBases(html));
  for (const o of others) {
    const of = firstImageBase(o.html);
    if (first && of && first === of) { out.push(`썸네일 사진이 같은 블로그 글과 중복: ${o.file} — [이미지 교체]로 첫 사진을 바꾸세요`); continue; }
    const hit = allImageBases(o.html).find(b => mine.has(b));
    if (hit) out.push(`본문 사진이 같은 블로그 글과 중복(${path.basename(hit)}): ${o.file}`);
  }
  return out;
}
function recentSameBlog(dir, entries, keyFn, me, limit = 15) {
  const key = keyFn(me);
  return entries.filter(p => p.file !== me.file && keyFn(p) === key).slice(-limit).map(p => {
    try { return { file: p.file, html: fs.readFileSync(path.join(dir, p.file), 'utf8') }; } catch { return null; }
  }).filter(Boolean);
}

// ── 전 채널 '최근 10편 사진' 재사용 금지 (2026-10-14: 같은 사진이 며칠 사이 티스토리→블로거로 다시 쓰임) ──
// 규칙: 블로거·티스토리·홈페이지 각각 최근 N편(기본 10)에 들어간 사진은 어느 채널에서도 다시 쓰지 않는다.
function recentImageBans(cfg, n = 10) {
  const out = new Map(); // base URL → { channel, file }
  const take = (dir, items, channel) => {
    for (const p of items.slice(-n)) {
      try { for (const b of allImageBases(fs.readFileSync(path.join(dir, p.file), 'utf8'))) if (!out.has(b)) out.set(b, { channel, file: p.file }); } catch {}
    }
  };
  try { take(paths(cfg).posts, (loadQueue(cfg).posts || []), '블로거'); } catch {}
  try { take(pathsTistory(cfg).posts, (loadQueueTistory(cfg).posts || []), '티스토리'); } catch {}
  try {
    for (const it of (loadQueueHomepage(cfg).posts || []).filter(x => x.status !== 'rejected').slice(-n)) {
      const ph = it.post && it.post.photo; if (!ph) continue;
      const b = String(ph).replace(/&amp;/g, '&').split('?')[0];
      if (!out.has(b)) out.set(b, { channel: '홈페이지', file: (it.post && it.post.slug) || '' });
    }
  } catch {}
  return out;
}
// 지금까지 어느 채널에서든 쓴 사진 전부 (후보 제외용)
function allUsedImages(cfg) {
  const set = new Set();
  for (const dir of [paths(cfg).posts, pathsTistory(cfg).posts]) {
    try { for (const fn of fs.readdirSync(dir)) { if (!/\.html$/.test(fn)) continue; for (const b of allImageBases(fs.readFileSync(path.join(dir, fn), 'utf8'))) set.add(b); } } catch {}
  }
  try { for (const it of (loadQueueHomepage(cfg).posts || [])) if (it.post && it.post.photo) set.add(String(it.post.photo).replace(/&amp;/g, '&').split('?')[0]); } catch {}
  return set;
}
function banPromptBlock(cfg) {
  let m; try { m = recentImageBans(cfg); } catch { return ''; }
  if (!m || !m.size) return '';
  const ids = [...m.entries()].map(([b, v]) => b.replace(/^https?:\/\/images\.(pexels|unsplash)\.com\//, '') + ` (${v.channel})`);
  return `- ★사용 금지 사진 — 전 채널(블로거·티스토리·홈페이지) 최근 10편에 이미 들어간 사진이다. 같은 사진은 최소 10편이 지나기 전에 다시 쓰지 않는다. 같은 ID 는 물론 같은 장면(예: 판사봉+노트북, 분석 대시보드가 뜬 노트북)의 비슷한 사진도 피한다:\n  ${ids.join('\n  ')}`;
}
// 생성 직후: 금지 목록에 걸린 사진 자리를 자동으로 새 사진으로 바꾼다 (대시보드 [이미지 교체] 와 같은 방식)
async function autoReplaceBanned(cfg, fp, title, log) {
  const res = { warns: [], replaced: 0 };
  let html; try { html = fs.readFileSync(fp, 'utf8'); } catch { return res; }
  const me = path.basename(fp);
  const bans = recentImageBans(cfg);
  const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map(m => {
    const tag = m[0];
    const heads = [...html.slice(0, m.index).matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)];
    const section = heads.length ? heads[heads.length - 1][1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
    const src = (tag.match(/src="([^"]+)"/) || [])[1] || '';
    return { tag, section, src, alt: (tag.match(/alt="([^"]*)"/) || [])[1] || '', base: src.replace(/&amp;/g, '&').split('?')[0] };
  }).filter(x => x.src);
  const dup = imgs.filter(x => { const v = bans.get(x.base); return v && v.file !== me; });
  if (!dup.length) return res;
  log && log(`  ★최근 10편에 쓴 사진 재사용 ${dup.length}장 → 자동 교체: ${dup.map(x => path.basename(x.base) + '←' + bans.get(x.base).channel + ' ' + bans.get(x.base).file).join(', ')}`);
  let picks = [];
  try {
    const PICK = require('./image-pick');
    picks = await PICK.pickInline({ E: { runClaude }, cfg, log, title, slots: dup, used: allUsedImages(cfg), hint: '' });
  } catch (e) { log && log('  자동 교체 실패: ' + e.message); }
  let out = html;
  dup.forEach((x, i) => {
    const pick = picks[i];
    if (!pick) { res.warns.push(`사진 재사용(최근 10편 내): ${path.basename(x.base)} — 새 사진을 찾지 못함, [이미지 교체] 필요`); return; }
    const newTag = x.tag.split(x.src).join(pick.url).replace(/alt="[^"]*"/, m => pick.alt ? `alt="${pick.alt}"` : m);
    out = out.replace(x.tag, newTag).split(x.src).join(pick.url);
    res.replaced++;
    log && log(`  ${x.section || '도입부'} 자리 교체 → ${pick.url}`);
  });
  if (res.replaced) { fs.writeFileSync(fp, out, 'utf8'); res.warns.push(`사진 ${res.replaced}장 자동 교체됨(최근 10편 재사용) — 미리보기로 확인`); }
  return res;
}

// ── 실행 후 검증 리포트 ──
async function postRunVerify(cfg, beforeFiles, log) {
  const P = paths(cfg);
  fixQuestionTitles(cfg, 'blogger', p => !beforeFiles.has(p.file), log);
  const scores = parseScores(cfg);
  const all = todayEntries(cfg);
  const fresh = all.filter(p => !beforeFiles.has(p.file));
  const slugs = (loadQueue(cfg).posts || []).map(p => p.slug).filter(Boolean);
  const report = [];
  for (const p of fresh) {
    const r = { file: p.file, blog: blogNameOf(cfg, p.blog_url), blog_url: p.blog_url, title: p.title || '', slug: p.slug || '', score: scores[p.title] ?? null, issues: [], warns: [], chars: 0, imgOk: null };
    const fp = path.join(P.posts, p.file);
    if (!fs.existsSync(fp)) { r.issues.push('파일 없음'); report.push(r); continue; }
    const _img = { warns: [] }; await fixInlineImages(fp, _img, log, cfg);
    const html = fs.readFileSync(fp, 'utf8');
    _img.warns.push(...dupImageWarns(html, recentSameBlog(P.posts, (loadQueue(cfg).posts || []), x => x.blog_url, p)));
    { const ar = await autoReplaceBanned(cfg, fp, p.title || '', log); _img.warns.push(...ar.warns); }
    const qa = qaCheckHtml(html);
    r.issues = qa.issues; r.warns = qa.warns; r.chars = qa.chars;
    r.warns.push(..._img.warns);
    if (qa.chars < (cfg.minCharsNoSpace || 1800)) r.warns.push(`분량 ${qa.chars}자(<${cfg.minCharsNoSpace || 1800})`);
    if (slugs.filter(s => s === p.slug).length > 1) r.issues.push('slug 중복');
    if (!(p.labels || []).length) r.warns.push('라벨 없음');
    { const _h = fs.readFileSync(fp, 'utf8'); r.warns.push(...lengthWarns(p.title, _h), ...summaryWarns(_h), ...introWarns(_h)); }
    if (!p.meta_description) r.warns.push('검색 설명 없음');
    if (r.score !== null && r.score < (cfg.minScore || 18)) r.warns.push(`자가채점 ${r.score}/20(<${cfg.minScore || 18})`);
    if (r.score === null) r.warns.push('topics_log 채점 기록 없음');
    // 이미지 URL 실접근 확인(최대 6장)
    let ok = 0, bad = [];
    for (const u of qa.imgs.slice(0, 6)) { (await checkUrl(u)) ? ok++ : bad.push(u); }
    r.imgOk = `${ok}/${qa.imgs.length}`;
    if (bad.length) r.warns.push(`이미지 ${bad.length}장 접근 실패`);
    report.push(r);
    log && log(`  [검증] ${p.file} · ${r.blog} · 채점 ${r.score ?? '?'} · 오류 ${r.issues.length} · 경고 ${r.warns.length}`);
  }
  if (all.length) buildOutputFolder(cfg, all, log);
  const result = { date: today(), at: new Date().toISOString(), fresh: report, todayTotal: all.length };
  try { fs.writeFileSync(P.lastRun, JSON.stringify(result, null, 2), 'utf8'); } catch {}
  return result;
}

// ════════════════════════════════════════════════════════════════════
// ── 티스토리 채널 (2026-08-13 통합 — 블로거와 같은 대시보드에서 생성·발행) ──
//    생성: 티스토리 전용 프롬프트가 posts\medi_tistory*.html + queue_tistory.json 적재.
//    발행: tistory-poster.js (redtrans-tistory-auto watcher.js 이식, Playwright+TinyMCE).
// ════════════════════════════════════════════════════════════════════
function tcfg(cfg) { return cfg.tistory || {}; }
function pathsTistory(cfg) {
  const base = cfg.baseDir || __dirname;
  return {
    base,
    posts: path.join(base, 'posts'),
    queue: path.join(base, 'queue_tistory.json'),
    cats: path.join(base, 'categories_tistory.json'),
    lastRun: path.join(base, '_last_run_tistory.json'),
    // 티스토리 보관 폴더 — 설정이 없으면 블로거 보관 폴더 옆의 '메세지_티스토리_출력'
    outDir: (tcfg(cfg).outputDir) || path.join(path.dirname(cfg.outputDir), '티스토리'),
  };
}
function loadQueueTistory(cfg) { return readJsonSafe(pathsTistory(cfg).queue, { posts: [] }); }
function todayEntriesTistory(cfg) {
  const pref = 'medi_tistory' + todayCompact() + '_';
  return (loadQueueTistory(cfg).posts || []).filter(p => (p.file || '').startsWith(pref));
}
function loadTistoryCats(cfg) { return readJsonSafe(pathsTistory(cfg).cats, {}); }

function buildRunPromptTistory(cfg, opts = {}) {
  const T = tcfg(cfg);
  const enginePrompt = fs.readFileSync(T.enginePrompt, 'utf8');
  const P = pathsTistory(cfg);
  const pref = 'medi_tistory' + todayCompact() + '_';
  let existing = [];
  try { existing = fs.readdirSync(P.posts).filter(f => f.startsWith(pref)); } catch {}
  const startN = existing.length + 1;
  const only = opts.only ? (T.blogs || []).find(b => b.n === Number(opts.only)) : null;
  const count = opts.plan ? opts.plan.length : (only ? 1 : (T.postsPerRun || 5));
  const nList = Array.from({ length: count }, (_, i) => startN + i);
  const cats = loadTistoryCats(cfg);
  const catLines = (T.blogs || []).map(b => {
    const list = (cats[b.account] || []).map(c => c.name).filter(n => n && n !== '카테고리 없음');
    return `  · ${b.account}(${b.name}): ${list.length ? list.join(' / ') : '(카테고리 목록 없음 — category·articleSection 은 빈 문자열 ""로)'}`;
  }).join('\n');
  return enginePrompt + `

## ■ [자동 주입 — 이번 실행 정보 (서버가 삽입, 프롬프트 본문보다 우선)]
${banPromptBlock(cfg)}
- 오늘 날짜: ${today()} (파일명 날짜부: ${todayCompact()})
- 이번 실행에서 저장할 파일명: ${nList.map(n => `medi_tistory${todayCompact()}_${n}.html`).join(' · ')} (n=${nList.join(',')} — 기존 파일 덮어쓰기 절대 금지)
${existing.length ? `- ★오늘 이미 작성된 티스토리 원고 ${existing.length}건 존재(${existing.join(', ')}) — 그 글들과 주제·질문이 겹치면 안 된다.` : ''}
- 작업 폴더: ${P.base} (posts\\ · queue_tistory.json · medi_topics_log.txt 모두 이 안)
${only ? `- ★★이번 실행은 ${only.n}번 블로그 「${only.name}」(account: ${only.account}) 에 쓸 글 1편만 작성한다 — 프롬프트 본문의 "블로그마다 1편" 지시보다 이 줄이 우선. account 는 ${only.account}. 이 블로그의 진료과 각도를 따른다.` : ''}
- queue_tistory.json 은 기존 항목을 절대 삭제·수정하지 말고 ${count}개 항목만 append. slug 는 queue_tistory.json 과 queue.json(블로거)의 기존 슬러그 모두와 중복 금지.
${planBlock(opts.plan, 'tistory')}
- ★계정별 실제 티스토리 카테고리 목록 (META 의 articleSection·큐의 category 는 반드시 이 중 하나를 그대로):
${catLines}
- 발행·게시·예약은 절대 하지 않는다(발행은 대시보드의 티스토리 발행 버튼이 tistory-poster.js 로 처리).
- 완료 후 마지막 출력: "티스토리 ${count}개 작성 완료" + 제목 ${count}개 목록.`;
}

// ── 티스토리 HTML QA — 블로거 QA와 달리: META 주석 필수, 이미지는 [[IMG]] 마커만(<img> 금지) ──
const META_RE = /<!--\s*META\s*([\s\S]*?)-->/;
function qaCheckHtmlTistory(html) {
  const issues = [], warns = [];
  let meta = null;
  const mm = html.match(META_RE);
  if (!mm) issues.push('META 주석 없음');
  else { try { meta = JSON.parse(mm[1].trim()); } catch { issues.push('META JSON 파싱 실패'); } }
  if (meta) {
    if (!meta.headline) issues.push('META headline 없음');
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(meta.slug || '')) issues.push('META slug 형식 오류(영문 소문자-하이픈)');
    if (!meta.keywords) warns.push('META keywords(태그) 없음');
    if (!meta.articleSection) warns.push('META articleSection(카테고리) 없음 — 카테고리 미지정 발행');
    if (!meta.description) warns.push('META description 없음');
  }
  const body = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const text = body.replace(/<[^>]+>/g, '');
  const noSpace = text.replace(/\s/g, '');
  if (/<h1/i.test(html)) issues.push('h1 존재');
  if (/<!DOCTYPE|<html|<head|<body/i.test(html)) issues.push('문서 래퍼 존재');
  if (EMOJI_RE.test(html)) issues.push('이모지 존재');
  if (/<style/i.test(html)) issues.push('<style> 존재');
  if (/display:\s*flex/i.test(html)) issues.push('display:flex 존재');
  const scripts = (html.match(/<script/g) || []).length;
  if (scripts !== 1) issues.push(`script ${scripts}개(FAQ 스키마 1개여야 함)`);
  let faqN = 0;
  const mj = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!mj) issues.push('FAQ 스키마 없음');
  else {
    try { JSON.parse(mj[1]); faqN = (mj[1].match(/"@type":\s*"Question"/g) || []).length; if (faqN !== 5) warns.push(`스키마 Question ${faqN}개(5개 권장)`); }
    catch { issues.push('스키마 JSON 파싱 실패'); }
  }
  const opens = (html.match(/<table/g) || []).length, closes = (html.match(/<\/table>/g) || []).length;
  if (opens !== closes) issues.push(`table 짝 불일치 ${opens}/${closes}`);
  const markers = [...html.matchAll(/\[\[IMG:\s*([^|\]]+?)\s*(?:\|\s*([^\]]*?))?\]\]/g)].map(m => ({ ref: m[1].trim(), alt: (m[2] || '').trim() }));
  // ★메세지는 이미지를 [[IMG]] 마커(드라이브 업로드) 대신 **실사 직접 URL <img>** 로 쓴다(프롬프트 규칙).
  //   그래서 <img> 는 오류가 아니라 정상이다. 둘 중 하나만 있으면 통과.
  const directImgs = [...body.matchAll(/<img\s[^>]*>/gi)].map(m => m[0]);
  const httpImgs = directImgs.filter(t => /src="https?:\/\//i.test(t));
  if (!markers.length && !directImgs.length) warns.push('이미지 없음(마커·직접 URL 모두 0개)');
  if (markers.length) {
    if (markers.some(x => !x.alt)) warns.push('alt 없는 이미지 마커 존재');
    if (markers.some(x => x.ref.includes('.') && !/^[A-Za-z0-9_-]{20,}$/.test(x.ref))) warns.push('마커에 드라이브 파일ID 아닌 값 존재');
  }
  if (directImgs.length) {
    if (httpImgs.length !== directImgs.length) issues.push(`<img> src 가 직접 URL(http)이 아닌 것 ${directImgs.length - httpImgs.length}개`);
    const noAlt = directImgs.filter(t => !/alt="[^"]+"/i.test(t)).length;
    if (noAlt) warns.push(`alt 없는 <img> ${noAlt}개`);
  }
  const hosts = new Set();
  for (const m of body.matchAll(/<a href="https?:\/\/([^/"]+)/g)) {
    const h = m[1].toLowerCase();
    if (!isSelfHost(h)) hosts.add(h.replace(/^www\./, ''));
  }
  if (hosts.size < 2) warns.push(`공식 외부링크 ${hosts.size}개(2개 필요: ${[...hosts].join(',') || '없음'})`);
  return { issues, warns, chars: noSpace.length, markers: markers.length, faqN, officialHosts: [...hosts], meta: meta || {} };
}

// ── 발행정보_티스토리.txt + 날짜 보관 폴더(블로거와 같은 폴더 공유) ──
function tistoryBlogName(cfg, account) {
  const b = (tcfg(cfg).blogs || []).find(x => x.account === account);
  return b ? b.name : (account || '');
}
function publishInfoTextTistory(cfg, entries) {
  const L = [];
  L.push(`[티스토리 발행 정보] 메세지 메디 블로그 — ${today()}`);
  L.push('');
  L.push('※ 발행은 대시보드 [티스토리 발행(공개)] 버튼이 자동 처리(제목·본문·이미지 업로드·태그·카테고리·영문 슬러그·FAQ 스키마).');
  L.push('※ 아래는 확인·수동 재발행용 참고 정보.');
  L.push('');
  entries.forEach((p, i) => {
    L.push('━'.repeat(34));
    L.push(`■ ${i + 1}번 글 → ${p.account || '?'} (${tistoryBlogName(cfg, p.account)})`);
    L.push('━'.repeat(34));
    L.push(`파일: ${p.file}`);
    L.push('');
    L.push('제목:');
    L.push(p.title || '');
    L.push('');
    L.push('카테고리:');
    L.push(p.category || '(미지정)');
    L.push('');
    L.push('태그(쉼표):');
    L.push(p.keywords || '');
    L.push('');
    L.push('영문 슬러그(발행 레이어 URL칸):');
    L.push(p.slug || '');
    L.push('');
    L.push('검색 설명(참고 — 티스토리는 본문 첫 400자 자동 추출):');
    L.push(p.meta_description || '');
    L.push('');
  });
  L.push('━'.repeat(34));
  L.push('■ 발행 후 공통 체크');
  L.push('━'.repeat(34));
  L.push('1. 글 주소가 /entry/영문슬러그 로 나왔는지 확인');
  L.push('2. 발행 글 Ctrl+U → "FAQPage" 검색 → 스키마 유지 확인 (지워졌으면 HTML 모드에서 맨 끝에 다시 붙여넣기)');
  L.push('3. 대시보드 티스토리 큐에서 상태가 발행됨으로 바뀌었는지 확인');
  return L.join('\n') + '\n';
}
// 원고를 고친 뒤(제목 다시·이미지 교체 등) 보관 폴더의 사본도 최신으로 맞춘다. 사본이 있던 날짜 폴더를 찾아 덮어쓰고, 없으면 오늘 폴더에 둔다.
function refreshOutputCopy(cfg, channel, file) {
  try {
    const src = path.join((channel === 'tistory' ? pathsTistory(cfg) : paths(cfg)).posts, path.basename(file));
    if (!fs.existsSync(src)) return '';
    const root = channel === 'tistory' ? pathsTistory(cfg).outDir : cfg.outputDir;
    let target = '';
    try { for (const d of fs.readdirSync(root)) { const fp = path.join(root, d, path.basename(file)); if (fs.existsSync(fp)) target = fp; } } catch {}
    if (!target) { fs.mkdirSync(path.join(root, today()), { recursive: true }); target = path.join(root, today(), path.basename(file)); }
    fs.copyFileSync(src, target);
    return target;
  } catch { return ''; }
}

function buildOutputFolderTistory(cfg, entries, log) {
  const dir = path.join(pathsTistory(cfg).outDir, today());
  fs.mkdirSync(dir, { recursive: true });
  const P = pathsTistory(cfg);
  for (const p of entries) {
    const src = path.join(P.posts, p.file);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, p.file));
  }
  fs.writeFileSync(path.join(dir, '발행정보_티스토리.txt'), publishInfoTextTistory(cfg, entries), 'utf8');
  log && log(`  보관 폴더 갱신: ${dir} (티스토리 글 ${entries.length}건 + 발행정보_티스토리.txt)`);
  return dir;
}

// ── 티스토리 실행 후 검증 리포트 ──
async function postRunVerifyTistory(cfg, beforeFiles, log) {
  const P = pathsTistory(cfg);
  fixQuestionTitles(cfg, 'tistory', p => !beforeFiles.has(p.file), log);
  const scores = parseScores(cfg);   // topics_log 는 두 채널 공용
  const all = todayEntriesTistory(cfg);
  const fresh = all.filter(p => !beforeFiles.has(p.file));
  const slugsT = (loadQueueTistory(cfg).posts || []).map(p => p.slug).filter(Boolean);
  const slugsB = (loadQueue(cfg).posts || []).map(p => p.slug).filter(Boolean);
  const accounts = new Set((tcfg(cfg).blogs || []).map(b => b.account));
  const report = [];
  for (const p of fresh) {
    const r = { file: p.file, blog: '티스토리·' + tistoryBlogName(cfg, p.account), account: p.account || '', title: p.title || '', slug: p.slug || '', score: scores[p.title] ?? null, issues: [], warns: [], chars: 0, imgOk: null, channel: 'tistory' };
    const fp = path.join(P.posts, p.file);
    if (!fs.existsSync(fp)) { r.issues.push('파일 없음'); report.push(r); continue; }
    const _img = { warns: [] }; await fixInlineImages(fp, _img, log, cfg);
    const html = fs.readFileSync(fp, 'utf8');
    _img.warns.push(...dupImageWarns(html, recentSameBlog(P.posts, (loadQueueTistory(cfg).posts || []), x => x.account, p)));
    { const ar = await autoReplaceBanned(cfg, fp, p.title || '', log); _img.warns.push(...ar.warns); }
    const qa = qaCheckHtmlTistory(html);
    r.issues = qa.issues; r.warns = qa.warns; r.chars = qa.chars;
    r.warns.push(..._img.warns);
    r.imgOk = String(qa.markers) + '마커';
    if (qa.chars < (cfg.minCharsNoSpace || 1800)) r.warns.push(`분량 ${qa.chars}자(<${cfg.minCharsNoSpace || 1800})`);
    if (!accounts.has(p.account)) r.issues.push(`account 값 오류(${p.account || '없음'})`);
    if (slugsT.filter(s => s === p.slug).length > 1) r.issues.push('slug 중복(티스토리 큐)');
    if (p.slug && slugsB.includes(p.slug)) r.warns.push('slug 가 블로거 큐와 중복');
    if (!p.category) r.warns.push('카테고리 없음');
    { const _h = fs.readFileSync(fp, 'utf8'); r.warns.push(...lengthWarns(p.title, _h), ...summaryWarns(_h), ...introWarns(_h)); }
    if (!p.keywords) r.warns.push('태그 없음');
    if (!p.meta_description) r.warns.push('검색 설명 없음');
    if (r.score !== null && r.score < (cfg.minScore || 18)) r.warns.push(`자가채점 ${r.score}/20(<${cfg.minScore || 18})`);
    if (r.score === null) r.warns.push('topics_log 채점 기록 없음');
    report.push(r);
    log && log(`  [검증] ${p.file} · ${r.blog} · 채점 ${r.score ?? '?'} · 오류 ${r.issues.length} · 경고 ${r.warns.length}`);
  }
  if (all.length) buildOutputFolderTistory(cfg, all, log);
  const result = { date: today(), at: new Date().toISOString(), fresh: report, todayTotal: all.length };
  try { fs.writeFileSync(P.lastRun, JSON.stringify(result, null, 2), 'utf8'); } catch {}
  return result;
}

// ════════════════════════════════════════════════════════════════════
// ── 홈페이지 칼럼 채널 (messeze.com/blog — 발행은 homepage-api-poster.js) ──
//    생성: 홈페이지 자동작성 프롬프트가 마스터 프롬프트를 읽고 칼럼 1편 + 산출물 4종을
//          메세지_홈페이지_칼럼_출력\<날짜>\ 에 직접 저장 + queue_homepage.json 적재.
//    발행: 자동화 불가(서버=openresty+PHP) — 사람이 admin 글 추가 + 치환룰로 처리 후
//          대시보드 [발행 처리] 버튼으로 상태만 갱신.
// ════════════════════════════════════════════════════════════════════
function hcfg(cfg) { return cfg.homepage || {}; }
function pathsHomepage(cfg) {
  const base = cfg.baseDir || __dirname;
  return {
    base,
    outDir: hcfg(cfg).outputDir || path.join(base, 'homepage_out'),
    queue: path.join(base, 'queue_medi.json'),
    lastRun: path.join(base, '_last_run_homepage.json'),
  };
}
function loadQueueHomepage(cfg) { return readJsonSafe(pathsHomepage(cfg).queue, { posts: [] }); }
function todayEntriesHomepage(cfg) {
  return (loadQueueHomepage(cfg).posts || []).filter(p => p.date === today());
}

function buildRunPromptHomepage(cfg) {
  const H = hcfg(cfg);
  const enginePrompt = fs.readFileSync(H.enginePrompt, 'utf8');
  const P = pathsHomepage(cfg);
  const outToday = path.join(P.outDir, today());
  const existing = todayEntriesHomepage(cfg);
  const slugs = (loadQueueHomepage(cfg).posts || []).map(p => p.slug).filter(Boolean);
  // 남은 편수 = 목표 - 오늘 이미 작성분 (강제 추가 생성이면 최소 1편)
  const want = Math.max(1, (H.postsPerRun || 1) - existing.length);
  return enginePrompt + `

## ■ [자동 주입 — 이번 실행 정보 (서버가 삽입, 프롬프트 본문보다 우선)]
${banPromptBlock(cfg)}
- 오늘 날짜: ${today()}
- ★이번 실행 목표 편수: **${want}편** (이 숫자가 최종 기준 — 프롬프트 본문의 편수 표기보다 우선)
- 오늘 출력 폴더: ${outToday}  (편당 산출물 4종 = 총 ${want * 4}개 파일, 전부 이 안에 저장 — 없으면 만든다)
- 작업 폴더: ${P.base} (queue_homepage.json · medi_topics_log.txt 이 안)
${existing.length ? `- ★오늘 이미 작성된 홈페이지 칼럼 ${existing.length}건 존재(${existing.map(p => p.file).join(', ')}) — 주제·업장·이미지·슬러그가 겹치면 안 된다.` : ''}
${slugs.length ? `- 큐에 이미 있는 슬러그(중복 금지): ${slugs.join(', ')}` : ''}
- queue_homepage.json 은 기존 항목을 절대 삭제·수정하지 말고 ${want}개 항목만 append. topics_log 도 ${want}줄 추가.
- ★한 편을 완전히 끝내고(파일 4종+큐+로그) 다음 편으로 넘어간다. ${want}편은 사업 라인·업장·이미지 파일ID·제목 형식이 서로 달라야 한다.
- 발행·업로드·admin 조작 절대 금지 — 파일 저장·큐 적재·topics_log 기록까지만.
- 완료 후 마지막 출력: "홈페이지 칼럼 ${want}편 작성 완료" + 편별 제목·슬러그.`;
}

// ── 홈페이지 칼럼 QA(2026-08-14 개편) — 산출물이 CMS 원고(마크업 .md + cms.json)로 바뀜.
//    CMS가 제목·리드·목차·FAQ·스타일을 자동 생성하므로 원고는 '마크업 최소주의'여야 한다.
function qaCheckHomepageDoc(md, cms) {
  const issues = [], warns = [];
  // 분량은 태그·마커를 뺀 실제 글자 수로 센다(핑크 컴포넌트 HTML 이 분량으로 잡히면 안 된다)
  const text = md.replace(/\[\[img:[^\]]*\]\]/g, '').replace(/^#{2,3}\s.*$/gm, '').replace(/<[^>]+>/g, '');
  const chars = text.replace(/\s/g, '').length;
  const h2 = (md.match(/^##\s+\S/gm) || []).length + (md.match(/<h2[\s>]/gi) || []).length;
  if (h2 < 3) issues.push(`소제목(h2) ${h2}개(3개 이상)`);
  if (chars < 1500) warns.push(`분량 ${chars}자(<1500)`);

  // 금지 마크업 — CMS가 자동 생성하는 것을 원고에서 또 만들면 화면이 깨진다
  //  ★2026-08-15 정책 변경(사용자 확정 '하이브리드'): 리드 박스·목차·FAQ 아코디언은 CMS 것을 그대로 쓰고,
  //    CMS가 제공하지 않는 핑크 컴포넌트 3종(비교표·신뢰지표·CTA)만 HTML 로 허용한다.
  //    발행기(homepage-poster)가 이 원고를 HTML 로 변환해 body_format=html 로 올린다.
  //  ★2026-08-15 사용자 확정: 홈페이지 칼럼도 기준 칼럼(blog-vietnam-spa-store-content)과 같은
  //    '풀 핑크 레이아웃' — SUMMARY 카드·POINT 01~04·비교표·신뢰지표·CTA 를 본문 HTML 로 넣는다.
  //    CMS 가 렌더하는 h1·목차·FAQ 아코디언만 본문에서 금지한다.
  if (/<script/i.test(md)) issues.push('<script> 존재(CMS가 제거 — FAQ 스키마는 CMS FAQ란이 생성)');
  if (!/SUMMARY\s*[·ㆍ]\s*핵심\s*요약/i.test(md)) warns.push('SUMMARY 핵심 요약 카드 없음(기준 칼럼 레이아웃)');
  // 인사말 — POINT 01 앞 도입 문단에 있어야 한다(섹션 안으로 들어가면 안 됨)
  const greetAt = md.indexOf('안녕하세요, 메세지입니다');
  const point1At = md.search(/POINT\s*01/i);
  if (greetAt === -1) warns.push('인사말("안녕하세요, 메세지입니다.") 없음');
  else if (point1At !== -1 && greetAt > point1At) warns.push('인사말이 POINT 섹션 안에 있음(도입 문단으로 옮길 것)');
  // 리드 박스(cms.summary)와 본문 첫 문단이 사실상 같으면 같은 문장이 두 번 노출된다
  if (cms && cms.summary) {
    const firstPara = (md.split(/\n\s*\n/).find(b => b.trim() && !/^[<\[\-#>]/.test(b.trim())) || '').trim();
    const norm = (s) => (s || '').replace(/[\s.,·"'?!]/g, '');
    const a = norm(firstPara).slice(0, 120), b = norm(cms.summary).slice(0, 120);
    if (a && b && (a.startsWith(b.slice(0, 40)) || b.startsWith(a.slice(0, 40)))) warns.push('첫 문단이 cms.summary(리드 박스)와 중복');
  }
  const points = new Set((md.match(/POINT\s*0\d/gi) || []).map(s => s.toUpperCase().replace(/\s+/g, ' ')));
  if (points.size < 3) warns.push(`POINT 섹션 헤더 ${points.size}개(4개 권장)`);
  if (/재계약율/.test(md) === false) warns.push('신뢰지표 스탯 블록 없음');
  if (!/border-top:\s*4px solid #fa6781/i.test(md)) warns.push('CTA 박스 없음(본문 맨 끝)');
  if (/^#\s+\S/m.test(md) || /<h1/i.test(md)) issues.push('h1 존재(제목은 CMS가 렌더)');
  if (/^##\s*(자주 묻는 질문|FAQ)\s*$/im.test(md)) issues.push('본문에 FAQ 섹션 존재(FAQ는 cms.json)');
  if (/^##\s*목차\s*$/im.test(md) || /tv-posttoc/.test(md)) issues.push('수동 목차 존재');
  if (EMOJI_RE.test(md)) issues.push('이모지 존재');

  // 이미지 마커
  const imgs = [...md.matchAll(/\[\[img:\s*([^|\]]+?)\s*(?:\|\s*([^\]]*?))?\]\]/g)].map(m => ({ url: m[1].trim(), cap: (m[2] || '').trim() }));
  if (imgs.length < 4 || imgs.length > 6) warns.push(`이미지 ${imgs.length}장(4~6장)`);
  if (imgs.some(i => !i.cap)) warns.push('캡션 없는 이미지 존재');
  if (imgs.some(i => !/^https?:\/\//.test(i.url))) issues.push('이미지 URL 형식 오류');

  // 링크 — 공식 출처 2개 이상, 외부 블로그 금지
  const hosts = new Set();
  // 마크다운 링크 + 핑크 블록 안의 <a href="..."> 를 함께 센다(핑크 컴포넌트 허용 이후 필수)
  const linkHosts = [
    ...[...md.matchAll(/\]\((https?:\/\/([^/)"]+))[^)]*\)/g)].map(m => m[2]),
    ...[...md.matchAll(/<a\s[^>]*href="https?:\/\/([^/"]+)/gi)].map(m => m[1]),
  ];
  for (const raw of linkHosts) {
    const h = raw.toLowerCase().replace(/^www\./, '');
    if (/(?:^|\.)(tistory\.com|blogspot\.com)$/.test(h) || h === 'blog.naver.com') issues.push('외부 블로그 링크 존재');
    if (!/(?:^|\.)(messeze\.com|googleusercontent\.com|kakao\.com)$/.test(h) && h !== 'google.com') hosts.add(h);
  }
  if (hosts.size < 2) warns.push(`공식 외부링크 ${hosts.size}개(2개 필요: ${[...hosts].join(',') || '없음'})`);

  // cms.json
  if (!cms) issues.push('cms.json 없음');
  else {
    for (const k of ['title', 'slug', 'category', 'summary']) if (!cms[k]) issues.push(`cms.json ${k} 없음`);
    if (cms.slug && !/^[a-z0-9]+(-[a-z0-9]+){2,}$/.test(cms.slug)) issues.push(`슬러그 형식 오류(키워드 3개 이상 하이픈): ${cms.slug}`);
    const faq = (cms.faq || []).filter(f => f && f.q && f.a);
    if (faq.length < 3) warns.push(`FAQ ${faq.length}개(3~5개)`);
    if (cms.summary && (cms.summary.length < 60 || cms.summary.length > 170)) warns.push(`summary ${cms.summary.length}자(80~155자 권장)`);
    if (!cms.thumbnail_url) warns.push('thumbnail_url 없음');
  }
  return { issues, warns, chars, h2, imgs: imgs.map(i => i.url), officialHosts: [...hosts] };
}

// ── (구) 정적 HTML 칼럼 QA — 2026-08-12~14 산출분 검증용으로만 남겨둔다 ──
function qaCheckHtmlHomepage(html) {
  const issues = [], warns = [];
  if (!/<!DOCTYPE/i.test(html) || !/<html/i.test(html)) issues.push('완성 문서 아님(DOCTYPE/html 없음)');
  const h1s = (html.match(/<h1[\s>]/gi) || []).length;
  if (h1s !== 1) issues.push(`h1 ${h1s}개(1개여야 함)`);
  const canon = (html.match(/<link[^>]+rel="canonical"/gi) || []).length;
  if (canon !== 1) issues.push(`canonical ${canon}개(1개여야 함 — 기존 페이지 오류 반복 금지)`);
  const ogd = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]*)"/i) || html.match(/<meta[^>]+content="([^"]*)"[^>]+property="og:description"/i);
  if (!ogd || !ogd[1].trim()) issues.push('og:description 비었음(기존 페이지 오류 반복 금지)');
  const md = html.match(/<meta[^>]+name="description"[^>]+content="([^"]*)"/is) || html.match(/<meta[^>]+content="([^"]*)"[^>]+name="description"/is);
  if (!md || !md[1].trim()) issues.push('meta description 없음');
  if (!/<title>[^<]*메세지[^<]*<\/title>/.test(html)) warns.push('title 에 "메세지" 없음');
  if (!/_next\/static\/css/.test(html)) issues.push('사이트 CSS 링크(_next/static/css) 없음 — 템플릿 훼손');
  // 스키마 3종
  const jsons = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => m[1]);
  let hasArticle = false, hasFaq = false, hasBread = false, badJson = 0;
  for (const j of jsons) {
    try { JSON.parse(j); } catch { badJson++; }
    if (/"@type":\s*"(?:News)?Article"/.test(j)) hasArticle = true;
    if (/"@type":\s*"FAQPage"/.test(j)) hasFaq = true;
    if (/"@type":\s*"BreadcrumbList"/.test(j)) hasBread = true;
  }
  if (badJson) issues.push(`스키마 JSON 파싱 실패 ${badJson}개`);
  if (!hasArticle) issues.push('Article 스키마 없음');
  if (!hasFaq) issues.push('FAQPage 스키마 없음');
  if (!hasBread) issues.push('BreadcrumbList 스키마 없음');
  // 본문(article) 기준 분량·이미지·링크·이모지 (사이트 공통 요소는 검사 제외 — 언어 버튼 🌐 등 오탐 방지)
  const art = (html.match(/<article[\s\S]*?<\/article>/i) || [html])[0];
  if (EMOJI_RE.test(art)) issues.push('이모지 존재(article 내)');
  const schemaAll = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => m[1]).join('');
  if (EMOJI_RE.test(schemaAll)) issues.push('이모지 존재(스키마 내)');
  const text = art.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, '');
  const noSpace = text.replace(/\s/g, '');
  const imgs = [...art.matchAll(/<img [^>]*src="([^"]+)"/g)].map(m => m[1]);
  const lh3 = imgs.filter(u => /lh3\.googleusercontent\.com/.test(u));
  if (imgs.length < 4) warns.push(`이미지 ${imgs.length}장(4~6장 필요)`);
  if (imgs.some(u => /^data:/i.test(u))) issues.push('data URI 이미지 존재(금지)');
  if (imgs.some(u => !u.trim())) issues.push('src 빈 이미지 존재');
  // 외부 블로그 링크 금지 / 공식 외부링크 2개
  if (/<a [^>]*href="https?:\/\/[^"]*(?:tistory\.com|blogspot\.com|blog\.naver\.com)/i.test(art)) issues.push('외부 블로그 링크 존재(홈페이지 칼럼 금지)');
  // ★홈페이지 전용 자사 호스트 — google.com 계열 중 support/developers/policies 등 '공식 문서'는
  //   외부 출처로 인정한다(자사 블로그 호스팅인 blogspot·googleusercontent 만 제외).
  const SELF_HP = /(?:^|\.)(messeze\.com|tistory\.com|blogspot\.com|blogger\.com|googleusercontent\.com|kakao\.com)$/i;
  const hosts = new Set();
  for (const m of art.matchAll(/<a\s[^>]*href="https?:\/\/([^/"]+)/g)) {
    const h = m[1].toLowerCase().replace(/^www\./, '');
    if (SELF_HP.test(h) || h === 'google.com') continue;
    hosts.add(h);
  }
  if (hosts.size < 2) warns.push(`공식 외부링크 ${hosts.size}개(2개 필요: ${[...hosts].join(',') || '없음'})`);
  return { issues, warns, chars: noSpace.length, imgs, lh3N: lh3.length, officialHosts: [...hosts] };
}

// ── 홈페이지 칼럼 실행 후 검증 리포트 (산출물 4종은 에이전트가 직접 저장 — 서버는 검증만) ──
async function postRunVerifyHomepage(cfg, beforeFiles, log) {
  const P = pathsHomepage(cfg);
  const scores = parseScores(cfg);   // topics_log 공용 (홈페이지· 프리픽스 줄)
  const all = todayEntriesHomepage(cfg);
  const fresh = all.filter(p => !beforeFiles.has(p.file));
  const slugs = (loadQueueHomepage(cfg).posts || []).map(p => p.slug).filter(Boolean);
  const report = [];
  for (const p of fresh) {
    const dir = path.join(P.outDir, p.date || today());
    const r = { file: p.file, blog: '홈페이지·' + (p.data_cat || '칼럼'), title: p.title || '', slug: p.slug || '', score: scores[p.title] ?? null, issues: [], warns: [], chars: 0, imgOk: null, channel: 'homepage' };
    const fp = path.join(dir, p.file);
    if (!fs.existsSync(fp)) { r.issues.push('파일 없음'); report.push(r); continue; }
    const raw = fs.readFileSync(fp, 'utf8');
    const isMd = /\.md$/i.test(p.file);
    let qa;
    if (isMd) {
      const stem = p.file.replace(/_본문\.md$/i, '').replace(/\.md$/i, '');
      let cms = null;
      const cmsPath = path.join(dir, `${stem}_cms.json`);
      if (fs.existsSync(cmsPath)) { try { cms = JSON.parse(fs.readFileSync(cmsPath, 'utf8')); } catch { r.issues.push('cms.json JSON 파싱 실패'); } }
      qa = qaCheckHomepageDoc(raw, cms);
      if (!fs.existsSync(path.join(dir, `${stem}_발행정보.txt`))) qa.warns.push('발행정보 파일 없음');
    } else {
      qa = qaCheckHtmlHomepage(raw);   // 구 정적 HTML 산출분
      if (qa.chars < 1500) qa.warns.push(`분량 ${qa.chars}자(<1500)`);
    }
    r.issues = qa.issues.slice(); r.warns = qa.warns.slice(); r.chars = qa.chars;
    if (slugs.filter(s => s === p.slug).length > 1) r.issues.push('slug 중복(홈페이지 큐)');
    if (!p.meta_description) r.warns.push('검색 설명 없음');
    if (!p.data_cat) r.warns.push('분류(data_cat) 없음');
    if (r.score !== null && r.score < (cfg.minScore || 18)) r.warns.push(`자가채점 ${r.score}/20(<${cfg.minScore || 18})`);
    if (r.score === null) r.warns.push('topics_log 채점 기록 없음');
    // 이미지 URL 실접근 확인(최대 6장)
    let ok = 0, bad = [];
    for (const u of qa.imgs.slice(0, 6)) { (await checkUrl(u)) ? ok++ : bad.push(u); }
    r.imgOk = `${ok}/${qa.imgs.length}`;
    if (bad.length) r.warns.push(`이미지 ${bad.length}장 접근 실패`);
    report.push(r);
    log && log(`  [검증] ${p.file} · ${r.blog} · 채점 ${r.score ?? '?'} · 오류 ${r.issues.length} · 경고 ${r.warns.length}`);
  }
  // ★오류(하드 실패)가 있는 글은 큐에서 failed 로 내려 발행 대기줄에 남지 않게 한다
  //   (2026-08-14: 본문 없는 파일이 pending 으로 큐에 남았던 사고)
  const bad = report.filter(r => r.issues.length).map(r => r.file);
  const good = report.filter(r => !r.issues.length).map(r => r.file);
  if (bad.length || good.length) {
    const q = loadQueueHomepage(cfg);
    let changed = 0, recovered = 0;
    for (const p of (q.posts || [])) {
      if (bad.includes(p.file) && p.status !== 'failed') { p.status = 'failed'; changed++; }
      // ★검증 기준이 바뀌어(예: 2026-08-15 풀 핑크 레이아웃 전환) 과거에 failed 로 내려간 글이
      //   지금 기준으로는 문제가 없으면 다시 pending 으로 되살린다 — 규칙 변경 때 큐가 막히는 것을 방지.
      else if (good.includes(p.file) && p.status === 'failed') { p.status = 'pending'; recovered++; }
    }
    if (changed || recovered) {
      writeJsonSafe(P.queue, q, { guardKey: 'posts' });
      if (changed) log && log(`  ! 검증 실패 ${changed}건을 큐에서 failed 로 표시 — 발행 대상에서 제외(${bad.join(', ')})`);
      if (recovered) log && log(`  검증 통과로 되살린 글 ${recovered}건 — 다시 발행 대기(pending)`);
    }
  }
  const result = { date: today(), at: new Date().toISOString(), fresh: report, todayTotal: all.length };
  try { fs.writeFileSync(P.lastRun, JSON.stringify(result, null, 2), 'utf8'); } catch {}
  return result;
}

// ════════════════════════════════════════════════════════════════════
// ── 개별 글 '다시 생성' (2026-08-15) ─────────────────────────────────
//   대시보드 큐의 한 줄만 새로 쓴다. 기존 파일은 지우지 않고 _재생성_백업\ 으로 옮기고
//   큐 항목을 빼둔 뒤(슬러그 중복 방지) 1편만 쓰게 한다.
//   mode: 'same' = 같은 주제·제목·슬러그 유지하고 내용만 다시 / 'new' = 다른 주제로 새로
// ════════════════════════════════════════════════════════════════════
function regenChannel(cfg, channel) {
  if (channel === 'tistory') {
    const P = pathsTistory(cfg);
    return { name: '티스토리', queueFile: P.queue, queue: loadQueueTistory(cfg), fileDir: P.posts, enginePrompt: tcfg(cfg).enginePrompt };
  }
  if (channel === 'homepage') {
    const P = pathsHomepage(cfg);
    return { name: '홈페이지 칼럼', queueFile: P.queue, queue: loadQueueHomepage(cfg), fileDir: null, enginePrompt: hcfg(cfg).enginePrompt };
  }
  const P = paths(cfg);
  return { name: '블로거', queueFile: P.queue, queue: loadQueue(cfg), fileDir: P.posts, enginePrompt: cfg.enginePrompt };
}

// 기존 산출물 백업 + 큐에서 항목 제거 → { entry, movedFiles, outDir }
function prepareRegen(cfg, channel, file, log) {
  const C = regenChannel(cfg, channel);
  const entry = (C.queue.posts || []).find(p => p.file === file);
  if (!entry) throw new Error(`큐에서 찾지 못했습니다: ${file}`);
  if (entry.status === 'published') throw new Error('이미 발행된 글입니다 — 다시 생성 대신 발행처를 직접 수정하세요');

  // 대상 파일 모으기: 블로거·티스토리 = posts\<파일> 1개 / 홈페이지 = 날짜 폴더의 <슬러그>_* 전부
  let dir, targets;
  if (channel === 'homepage') {
    dir = path.join(pathsHomepage(cfg).outDir, entry.date || today());
    const stem = file.replace(/_본문\.(md|html)$/i, '');
    targets = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter(f => f.startsWith(stem));
  } else {
    dir = C.fileDir;
    targets = fs.existsSync(path.join(dir, file)) ? [file] : [];
  }
  const backup = path.join(dir, '_재생성_백업', `${today()}_${Date.now()}`);
  const moved = [];
  if (targets.length) {
    fs.mkdirSync(backup, { recursive: true });
    for (const t of targets) {
      try { fs.renameSync(path.join(dir, t), path.join(backup, t)); moved.push(t); } catch {}
    }
  }
  // 큐에서 제거(디스크에서 새로 읽어 다른 작업의 변경을 덮어쓰지 않게)
  let q = readJsonSafe(C.queueFile, { posts: [] });
  q.posts = (q.posts || []).filter(p => p.file !== file);
  writeJsonSafe(C.queueFile, q, { guardKey: 'posts' });
  log && log(`  기존 산출물 ${moved.length}개 백업 → ${backup}`);
  log && log(`  큐에서 항목 제거: ${file} (재작성 후 다시 append 된다)`);
  return { entry, movedFiles: moved, backup, dir };
}

// 다시 쓰기가 실패했을 때: 백업해 둔 파일과 큐 항목을 원래대로 되돌린다
function restoreRegen(cfg, channel, prep, log) {
  try {
    const C = regenChannel(cfg, channel);
    for (const f of (prep.movedFiles || [])) {
      const from = path.join(prep.backup, f), to = path.join(prep.dir, f);
      try { if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to); } catch {}
    }
    const q = readJsonSafe(C.queueFile, { posts: [] });
    if (!(q.posts || []).some(p => p.file === prep.entry.file)) {
      q.posts = (q.posts || []).concat([prep.entry]);
      writeJsonSafe(C.queueFile, q, { guardKey: 'posts' });
    }
    log && log(`  이전 글 복구: ${prep.entry.file}`);
    return true;
  } catch (e) { log && log('  이전 글 복구 실패: ' + e.message); return false; }
}

function buildRegenPrompt(cfg, channel, entry, mode, pick) {
  const C = regenChannel(cfg, channel);
  const enginePrompt = fs.readFileSync(C.enginePrompt, 'utf8');
  const keep = mode === 'same';
  const L = [];
  L.push('', '## ■ [자동 주입 — 이번 실행은 “한 편 다시 쓰기” (서버가 삽입, 프롬프트 본문보다 우선)]');
  { const bb = banPromptBlock(cfg); if (bb) L.push(bb); }
  L.push(`- 오늘 날짜: ${today()}`);
  L.push('- ★★이번 실행은 **정확히 1편만** 쓴다. 프롬프트 본문의 편수(3편 등)는 무시한다.');
  L.push(`- 대상: ${C.name} — 아래 글을 ${keep ? '**같은 주제로 다시**' : '**다른 주제로 새로**'} 쓴다.`);
  L.push(`  · 기존 제목: ${entry.title || '(없음)'}`);
  if (entry.slug) L.push(`  · 기존 슬러그: ${entry.slug}`);
  if (entry.q_no || entry.question) L.push(`  · 기존 질문: ${entry.q_no ? entry.q_no + ' ' : ''}${entry.question ? '"' + entry.question + '"' : ''}${keep ? ' — 이 질문 그대로 다시 쓴다(topics_log 에 이미 있어도 이번만 예외)' : ' — 이 질문은 쓰지 않는다'}`);
  if (pick && pick.row) {
    const r = pick.row;
    L.push(`  · ★이번에 쓸 질문(프로그램 지정 — 바꾸지 않는다): **${r.no}** "${r.q}" (지역 ${r.region} · 진료과 ${r.dept} · 진료항목 ${r.item} · 고민 유형 ${r.concern})${r.variant ? ` ★질문표 원문(${r.origDept}·${r.origItem})을 ${r.variant} 각도로 바꾼 질문` : ''}${pick.recycled ? ' ★전에 쓴 적 있는 질문 — 다른 각도로' : ''}`);
    L.push(`  · 큐 항목에 "q_no": "${r.no}", "question": "${r.q}" 를 반드시 넣는다. topics_log 에 [${r.no}] 를 적는다.`);
  }
  if (channel === 'tistory') L.push(`  · 계정(고정): ${entry.account} · 카테고리(고정): ${entry.category || '(없음)'}`);
  if (channel === 'blogger') L.push(`  · 발행 블로그(고정): ${entry.blog_url}`);
  if (channel === 'homepage') L.push(`  · 분류(고정): ${entry.data_cat || '(없음)'}`);
  L.push(`- ★기존 파일은 백업 폴더로 옮겨졌고 큐 항목도 빠졌다. **같은 파일명으로 새로 저장**하고 큐에 1개만 append 한다.`);
  if (channel === 'homepage') {
    L.push(`  · 저장 폴더: ${path.join(pathsHomepage(cfg).outDir, today())} (없으면 만든다) · 산출물 3종(본문.md · cms.json · 발행정보.txt)`);
    L.push(keep
      ? `  · 파일명 어간(그대로 사용): ${(entry.file || '').replace(/_본문\.(md|html)$/i, '')}`
      : `  · 파일명 어간은 **새로 지은 슬러그**를 따른다: blog-<새슬러그>_본문.md · blog-<새슬러그>_cms.json · blog-<새슬러그>_발행정보.txt`);
    L.push(`  · 큐(queue_homepage.json) 항목의 date 는 오늘 날짜로 적는다.`);
  } else {
    L.push(`  · 파일명(그대로 사용): ${entry.file} ${keep ? '' : '— 파일명은 날짜·번호 규칙이라 주제가 바뀌어도 그대로 쓴다'}`);
  }
  if (keep) {
    L.push('- ★같은 주제 유지 규칙: **제목·슬러그·분류는 위 값을 그대로 쓴다**(URL이 바뀌면 안 된다). 소재와 다루는 질문도 동일하게 가되,');
    L.push('  본문 구성·예시·표 구성·문장은 처음부터 새로 쓴다(백업본을 그대로 베끼지 말 것). 최신 규칙(디자인·컴포넌트·이미지·링크)을 전부 적용한다.');
    L.push('  ※ 백업본을 참고용으로 읽어도 되지만, 문단을 복사하지 말고 더 낫게 다시 쓴다.');
  } else {
    L.push('- ★새 주제 규칙: 위 기존 제목·주제와 **겹치지 않는 다른 소재**를 고른다. 슬러그도 새로 짓는다(기존 슬러그 재사용 금지).');
    L.push('  topics_log 와 큐의 기존 항목 전체와도 주제·질문이 겹치면 안 된다.');
  }
  L.push('- topics_log 에는 이 글 1줄만 추가한다(기존 줄 수정·삭제 금지).');
  L.push('- 발행·게시·예약은 하지 않는다. 파일 저장 + 큐 1건 append + 로그 1줄까지만.');
  L.push(`- 완료 후 마지막 출력: "1편 다시 작성 완료" + 제목·슬러그.`);
  return enginePrompt + L.join('\n');
}

module.exports = { planBlock, recentImageBans, allUsedImages, banPromptBlock, autoReplaceBanned, restoreRegen, regenChannel, questionTitle, fixQuestionTitles, replaceTitleInTopics, refreshOutputCopy, lengthWarns, summaryWarns, qaCheckHomepageDoc, prepareRegen, buildRegenPrompt, regenChannel, CLAUDE, loadCfg, paths, today, todayCompact, loadQueue, todayEntries, runClaude, buildRunPrompt, qaCheckHtml, parseScores, postRunVerify, buildOutputFolder, checkUrl,
  tcfg, pathsTistory, loadQueueTistory, todayEntriesTistory, loadTistoryCats, buildRunPromptTistory, qaCheckHtmlTistory, postRunVerifyTistory, buildOutputFolderTistory, tistoryBlogName,
  hcfg, pathsHomepage, loadQueueHomepage, todayEntriesHomepage, buildRunPromptHomepage, qaCheckHtmlHomepage, postRunVerifyHomepage,
  readJsonSafe, writeJsonSafe };
