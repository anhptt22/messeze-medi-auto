// accounts.js — Claude 다계정 관리
// - 계정별 독립 CLAUDE_CONFIG_DIR(폴더). 기본 계정은 사용자 홈(~/.claude)을 그대로 사용.
// - 로그인: `claude auth login --claudeai` → 브라우저 OAuth URL → 코드 붙여넣기(카드뉴스 앱과 동일 방식).
// - 상태: `claude auth status`(JSON: loggedIn/email/subscriptionType). 로그아웃: `claude auth logout`.
// - 자동 페일오버: 사용 중 계정이 미로그인/한도면 다음 건강한 계정으로 전환.
// ★비밀정보(토큰)는 이 모듈이 읽지 않는다. claude.exe가 각 폴더에서 처리한다.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// ★이 프로그램 전용 계정 저장소(프로그램 폴더 안 claude-accounts, 저장소에 올라가지 않는다) — PC 마다 대시보드에서 직접 로그인한다.
const ROOT = process.env.MEDI_CLAUDE_ACCOUNTS || path.join(__dirname, 'claude-accounts');
const ACCOUNTS_DIR = path.join(ROOT, 'profiles');
const STATE_FILE = path.join(ROOT, 'accounts.json');
const DEFAULT_NAME = '기본';
const DEFAULT_DIR = path.join(os.homedir(), '.claude');
const COOLDOWN_MS = 30 * 60 * 1000;   // 한도 소진 계정을 30분 쉬게 둔다
const STATUS_TTL = 60 * 1000;         // auth status 캐시 60초(폴링 때 매번 프로세스 띄우지 않도록)

// 로그인/한도 관련 오류 → 다른 계정으로 전환할 가치가 있는 오류. ★"You've hit your weekly limit · resets ..." 같은 실제 문구 포함.
const SWITCH_ERR = /organization has disabled|subscription access for Claude Code|Use an Anthropic API key instead|Not logged in|Please run \/login|login 필요|미로그인|usage limit|weekly limit|hit (your|the)[^.]*limit|limit reached|reached your (usage|weekly)|limit\s*·|resets?\s+(on|at|[A-Z][a-z]{2}\b)|rate.?limit|Credit balance|balance too low|quota|\b429\b|insufficient|out of (credit|quota)|Failed to authenticate|OAuth session expired|session (has )?expired|could not be refreshed|re-?authenticate|token (has )?expired|refresh token|Failed to refresh OAuth token|another Claude Code process is refreshing/i;
function isSwitchable(msg) { return SWITCH_ERR.test(String(msg || '')); }
function extractUrl(s) { const m = (s || '').match(/https?:\/\/[^\s"'<>]+/); return m ? m[0] : ''; }

function ensure() { try { fs.mkdirSync(ACCOUNTS_DIR, { recursive: true }); } catch {} }
function validName(name) { return /^[\w가-힣-]{1,24}$/.test(String(name || '').trim()); }
function accountDir(name) { return name === DEFAULT_NAME ? DEFAULT_DIR : path.join(ACCOUNTS_DIR, name); }

function load() {
  ensure();
  let st = {};
  try { st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
  if (!Array.isArray(st.accounts)) st.accounts = [];
  if (!st.accounts.find(a => a.name === DEFAULT_NAME)) st.accounts.unshift({ name: DEFAULT_NAME });
  if (!st.active || !st.accounts.find(a => a.name === st.active)) st.active = DEFAULT_NAME;
  return st;
}
function save(st) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2), 'utf8'); } catch {} }
function update(name, patch) { const st = load(); const a = st.accounts.find(x => x.name === name); if (a) { Object.assign(a, patch); save(st); } return a; }

// ★계정별 실행 환경. 기본 계정은 CLAUDE_CONFIG_DIR을 지워 홈 로그인을 그대로 쓴다.
function envFor(name) {
  const env = { ...process.env };
  if (name && name !== DEFAULT_NAME) env.CLAUDE_CONFIG_DIR = accountDir(name);
  else delete env.CLAUDE_CONFIG_DIR;
  return env;
}

function activeName() { return load().active; }
function setActive(name) { const st = load(); if (!st.accounts.find(a => a.name === name)) return false; st.active = name; save(st); return true; }
// ── 한도 메시지의 재개 시각 읽기 (2026-10-16) ──
// 예: "You've hit your session limit · resets 12:50pm (Asia/Bangkok)" / "resets Oct 20, 3pm (Asia/Seoul)" / "resets 1am"
// 반환: 지금부터 쉬어야 할 ms (읽지 못하면 null)
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function wallParts(ts, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = {}; for (const x of f.formatToParts(new Date(ts))) p[x.type] = x.value;
  return { y: +p.year, mo: +p.month - 1, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}
// 그 시간대의 벽시계 시각(y,mo,d,h,mi) → UTC ms
function zonedToUtc(y, mo, d, h, mi, tz) {
  let guess = Date.UTC(y, mo, d, h, mi);
  for (let i = 0; i < 3; i++) {
    const w = wallParts(guess, tz);
    const asUtc = Date.UTC(w.y, w.mo, w.d, w.h, w.mi, w.s);
    guess -= (asUtc - Date.UTC(y, mo, d, h, mi));
  }
  return guess;
}
function cooldownMsFromMsg(msg) {
  const m = String(msg || '').match(/resets\s+(?:(?:on\s+)?([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i);
  if (!m) return null;
  let tz = (m[6] || '').trim();
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined }); } catch { tz = ''; }
  if (!tz) tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let h = +m[3]; const mi = +(m[4] || 0); const ap = (m[5] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || mi > 59) return null;
  const now = Date.now(); const w = wallParts(now, tz);
  let y = w.y, mo = w.mo, d = w.d;
  const mon = m[1] ? MONTHS[m[1].toLowerCase()] : undefined;
  if (mon !== undefined && m[2]) { mo = mon; d = +m[2]; if (mo < w.mo - 6) y += 1; }
  let target = zonedToUtc(y, mo, d, h, mi, tz);
  if (mon === undefined) { while (target <= now) target += 24 * 3600 * 1000; }   // 날짜 없이 시각만 → 다음에 오는 그 시각
  const ms = target - now + 60 * 1000;                                              // 1분 여유
  if (ms < 60 * 1000 || ms > 8 * 24 * 3600 * 1000) return null;
  return ms;
}
function markCooldown(name, ms) { const st = load(); const a = st.accounts.find(x => x.name === name); if (a) { a.cooldownUntil = Date.now() + (ms || COOLDOWN_MS); save(st); } }
// active 다음으로, 쉬는 중이 아니고 '미로그인으로 확인되지 않은' 계정을 회전 탐색.
function nextHealthy(excludeName) {
  const st = load(); const now = Date.now(); const order = st.accounts.map(a => a.name);
  const start = Math.max(0, order.indexOf(excludeName));
  for (let i = 1; i <= order.length; i++) {
    const name = order[(start + i) % order.length];
    if (name === excludeName) continue;
    const a = st.accounts.find(x => x.name === name);
    if ((a.cooldownUntil || 0) <= now && a.loggedIn !== false) return name;
  }
  return null;
}

// ── claude 서브커맨드 실행(auth status/logout 등) — 텍스트/코드 반환 ──
function runSub(claudePath, name, args, timeoutMs) {
  return new Promise(resolve => {
    if (!claudePath) return resolve({ error: 'NO_CLI' });
    const useShell = String(claudePath).toLowerCase().endsWith('.cmd');
    const ch = spawn(claudePath, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: os.tmpdir(), shell: useShell, env: envFor(name) });
    let out = '', err = '', done = false;
    const t = setTimeout(() => { if (!done) { done = true; try { ch.kill(); } catch {} resolve({ error: 'TIMEOUT', out, err }); } }, timeoutMs || 30000);
    ch.stdout.on('data', d => out += d); ch.stderr.on('data', d => err += d);
    ch.on('error', e => { if (!done) { done = true; clearTimeout(t); resolve({ error: e.message }); } });
    ch.on('close', code => { if (!done) { done = true; clearTimeout(t); resolve({ code, out, err }); } });
  });
}

// ── 로그인 상태(이메일·구독) — 계정별로 캐시 ──
async function authStatus(name, claudePath, force) {
  const st = load(); const a = st.accounts.find(x => x.name === name);
  if (!a) return { loggedIn: false, error: 'NO_ACCOUNT' };
  if (!force && a.checkedAt && (Date.now() - a.checkedAt < STATUS_TTL))
    return { loggedIn: !!a.loggedIn, email: a.email || '', subscriptionType: a.plan || '' };
  const r = await runSub(claudePath, name, ['auth', 'status'], 25000);
  let data = { loggedIn: false, email: '', subscriptionType: '' };
  try {
    const j = JSON.parse(((r.out || '') + '').trim());
    data = { loggedIn: !!j.loggedIn, email: j.email || '', subscriptionType: j.subscriptionType || '' };
  } catch {
    const c = (r.out || '') + (r.err || '');   // JSON이 아니어도 이메일이 보이면 로그인으로 간주
    const em = (c.match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0];
    if (em && !/not logged in/i.test(c)) data = { loggedIn: true, email: em, subscriptionType: (c.match(/\b(max|pro|team|free)\b/i) || [''])[0] };
  }
  update(name, { loggedIn: data.loggedIn, email: data.email, plan: data.subscriptionType, checkedAt: Date.now() });
  return data;
}
async function refreshAll(claudePath) { const st = load(); for (const a of st.accounts) { try { await authStatus(a.name, claudePath, true); } catch {} } return list(); }

// ── 브라우저 OAuth 로그인 (1단계: URL 받기) ──
const _login = {};   // name -> { proc, out }
function loginStart(name, claudePath) {
  return new Promise(resolve => {
    if (!claudePath) return resolve({ ok: false, error: 'NO_CLI' });
    if (name !== DEFAULT_NAME) {
      if (!validName(name)) return resolve({ ok: false, error: '이름은 영문/숫자/한글 1~24자여야 합니다.' });
      const st = load(); if (!st.accounts.find(x => x.name === name)) { st.accounts.push({ name }); save(st); }
      try { fs.mkdirSync(accountDir(name), { recursive: true }); } catch {}
    }
    const useShell = String(claudePath).toLowerCase().endsWith('.cmd');
    if (_login[name] && _login[name].proc) { try { _login[name].proc.kill(); } catch {} }
    const ch = spawn(claudePath, ['auth', 'login', '--claudeai'], { stdio: ['pipe', 'pipe', 'pipe'], cwd: os.tmpdir(), shell: useShell, env: envFor(name) });
    _login[name] = { proc: ch, out: '' };
    let responded = false;
    const once = obj => { if (!responded) { responded = true; resolve(obj); } };
    const onData = d => { _login[name].out += d; const u = extractUrl(_login[name].out); if (u) once({ ok: true, url: u, needCode: true }); };
    ch.stdout.on('data', onData); ch.stderr.on('data', onData);
    ch.on('error', e => once({ ok: false, error: e.message }));
    ch.on('close', code => { if (_login[name] && _login[name].proc === ch) _login[name].proc = null; once({ ok: code === 0, code, url: extractUrl(_login[name] ? _login[name].out : '') }); });
    setTimeout(() => once({ ok: true, url: extractUrl(_login[name] ? _login[name].out : ''), needCode: true }), 9000);
  });
}
// ── 2단계: 로그인 페이지에서 받은 코드 붙여넣기 → stdin 입력 → 완료 ──
async function loginCode(name, code, claudePath) {
  const L = _login[name];
  if (!L || !L.proc) return { error: 'NO_LOGIN' };
  code = (code || '').trim();
  if (!code) return { error: '코드를 입력하세요' };
  const finished = new Promise(res => { let s = false; L.proc.on('close', () => { if (!s) { s = true; res(); } }); setTimeout(() => { if (!s) { s = true; res(); } }, 30000); });
  try { L.proc.stdin.write(code + '\n'); } catch {}
  await finished; _login[name].proc = null;
  const auth = await authStatus(name, claudePath, true);
  return { ok: !!auth.loggedIn, loggedIn: !!auth.loggedIn, email: auth.email || '', subscriptionType: auth.subscriptionType || '' };
}

// ── 로그아웃(구독 로그인 해제). remove=true면 계정 슬롯·폴더까지 삭제. ──
async function logout(name, claudePath, remove) {
  if (name === DEFAULT_NAME) return { ok: false, msg: '기본 계정(홈 로그인)은 여기서 해제하지 않습니다.' };
  await runSub(claudePath, name, ['auth', 'logout'], 20000);
  if (remove) {
    const st = load(); const i = st.accounts.findIndex(a => a.name === name);
    if (i >= 0) st.accounts.splice(i, 1);
    if (st.active === name) st.active = DEFAULT_NAME;
    save(st);
    try { fs.rmSync(accountDir(name), { recursive: true, force: true }); } catch {}
  } else {
    update(name, { loggedIn: false, email: '', plan: '', checkedAt: Date.now() });
  }
  return { ok: true };
}

// ── 계정 테스트 — 실제 생성과 동일하게 짧게 호출해 정상/한도/미로그인 판정 ──
function test(name, claudePath, model, log) {
  return new Promise((resolve) => {
    if (!claudePath) { log && log(`  [테스트:${name}] claude.exe 없음`); return resolve({ ok: false }); }
    const useShell = String(claudePath).toLowerCase().endsWith('.cmd');
    const p = spawn(claudePath, ['-p', '--model', model || 'opus', '--allowedTools', 'Read'], { windowsHide: true, shell: useShell, env: envFor(name) });
    let out = '', err = '';
    const to = setTimeout(() => { try { p.kill(); } catch {} log && log(`  [테스트:${name}] 시간초과`); resolve({ ok: false }); }, 90000);
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('error', e => { clearTimeout(to); log && log(`  [테스트:${name}] 실행오류 ${e.message}`); resolve({ ok: false }); });
    p.on('close', () => {
      clearTimeout(to);
      const c = out + '\n' + err;
      if (/Not logged in|Please run \/login/i.test(c)) { update(name, { loggedIn: false, checkedAt: Date.now() }); log && log(`  [테스트:${name}] ✗ 미로그인 — [연동]으로 로그인`); return resolve({ ok: false, loggedIn: false }); }
      if (isSwitchable(c)) { log && log(`  [테스트:${name}] ⚠ 한도 소진/제한 상태`); return resolve({ ok: false, limited: true }); }
      if (out.trim()) { log && log(`  [테스트:${name}] ✓ 정상 작동`); return resolve({ ok: true }); }
      log && log(`  [테스트:${name}] ✗ 빈 응답 ${err.replace(/\s+/g, ' ').slice(0, 60)}`); resolve({ ok: false });
    });
    p.stdin.write('숫자 1 하나만 출력해. 다른 말 절대 금지.'); p.stdin.end();
  });
}

// ── UI용 목록(캐시된 상태만 반환 — 프로세스 안 띄움) ──
function list() {
  const st = load(); const now = Date.now();
  return {
    active: st.active,
    accounts: st.accounts.map(a => ({
      name: a.name, isDefault: a.name === DEFAULT_NAME,
      cooling: (a.cooldownUntil || 0) > now, cooldownUntil: a.cooldownUntil || 0,
      loggedIn: a.loggedIn === true, email: a.email || '', plan: a.plan || '', checkedAt: a.checkedAt || 0,
    })),
  };
}

module.exports = {
  DEFAULT_NAME, isSwitchable, envFor, activeName, setActive, markCooldown, nextHealthy, cooldownMsFromMsg,
  authStatus, refreshAll, loginStart, loginCode, logout, test, list,
};
