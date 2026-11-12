// updater.js — 원격 업데이트 (GitHub 저장소 → 이 PC)
//   방식 1 (git)  : 프로그램 폴더가 git clone 으로 받은 것이면 `git pull --ff-only` 로 받는다.
//   방식 2 (zip)  : ZIP 으로 받아 푼 폴더면 저장소의 최신 ZIP 을 내려받아 프로그램 파일만 덮어쓴다.
//                   비공개 저장소는 update_token.txt (읽기 전용 GitHub 토큰 한 줄)가 있어야 한다.
//   어느 쪽이든 이 PC 의 데이터(원고·큐·로그인 세션·토큰·writer_config.local.json)는 저장소에 없는 파일이라 건드리지 않는다.
//   package.json 의 dependencies 가 바뀌었으면 npm install 을 다시 실행한다.
// 사용: node updater.js check   → 새 버전이 있는지 확인
//       node updater.js apply   → 새 버전을 받는다 (실행 창 RUN_dashboard.bat 이 시작할 때 자동으로 부른다)
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = __dirname;
const TOKEN_FILE = path.join(ROOT, 'update_token.txt');
let LAST = { ok: false, checkedAt: '', behind: false };

function cfg() { try { return require('./config').load().update || {}; } catch { return {}; } }
function branch() { return cfg().branch || 'main'; }
function localVersion() { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || ''; } catch { return ''; } }
function token() { try { const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); return /^[\w-]{20,}$/.test(t) ? t : ''; } catch { return ''; } }

// git 실행 파일: PATH → GitHub Desktop 내장 git 순으로 찾는다
let GIT;
function findGit() {
  if (GIT !== undefined) return GIT;
  const cands = ['git'];
  try {
    const gd = path.join(process.env.LOCALAPPDATA || '', 'GitHubDesktop');
    for (const d of fs.readdirSync(gd).filter(n => n.startsWith('app-')).sort().reverse()) cands.push(path.join(gd, d, 'resources', 'app', 'git', 'cmd', 'git.exe'));
  } catch {}
  cands.push('C:\\Program Files\\Git\\cmd\\git.exe');
  for (const c of cands) {
    try { execFileSync(c, ['--version'], { stdio: 'ignore', windowsHide: true }); GIT = c; return GIT; } catch {}
  }
  GIT = null; return GIT;
}
function git(args, opts = {}) {
  return execFileSync(findGit(), args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, ...opts }).trim();
}
function mode() {
  if (fs.existsSync(path.join(ROOT, '.git')) && findGit()) return 'git';
  if (repoSlug()) return 'zip';
  return 'none';
}
// "owner/name" — 설정(update.repo) 우선, 없으면 git 원격 주소에서
function repoSlug() {
  const r = String(cfg().repo || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(r)) return r;
  try {
    if (fs.existsSync(path.join(ROOT, '.git')) && findGit()) {
      const m = git(['remote', 'get-url', 'origin']).match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
      if (m) return m[1];
    }
  } catch {}
  return '';
}

function cmpVer(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0), pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}

function httpGet(url, { binary = false, hops = 0, headers = {} } = {}) {
  return new Promise((resolve) => {
    const h = { 'User-Agent': 'medi-auto-updater', ...headers };
    const req = https.get(url, { headers: h, timeout: 60000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 5) {
        res.resume();
        // 다른 호스트(codeload 등)로 넘어갈 때는 인증 헤더를 보내지 않는다
        const next = new URL(res.headers.location, url);
        const keep = next.host === new URL(url).host ? headers : Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'authorization'));
        return resolve(httpGet(next.href, { binary, hops: hops + 1, headers: keep }));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); resolve({ status: res.statusCode, body: binary ? buf : buf.toString('utf8') }); });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: binary ? Buffer.alloc(0) : '' }); });
    req.on('error', () => resolve({ status: 0, body: binary ? Buffer.alloc(0) : '' }));
  });
}
function apiHeaders() { const t = token(); return t ? { Authorization: 'Bearer ' + t, Accept: 'application/vnd.github+json' } : { Accept: 'application/vnd.github+json' }; }

// ── 확인 ──
async function check() {
  const version = localVersion();
  const m = mode();
  let r;
  try {
    if (m === 'git') {
      git(['fetch', '--quiet', 'origin', branch()]);
      const n = parseInt(git(['rev-list', '--count', `HEAD..origin/${branch()}`]), 10) || 0;
      let latest = version, notes = '';
      if (n) {
        try { latest = JSON.parse(git(['show', `origin/${branch()}:package.json`])).version || version; } catch {}
        try { notes = git(['log', '--format=· %s', '-8', `HEAD..origin/${branch()}`]); } catch {}
      }
      r = { ok: true, mode: m, version, latest, behind: n > 0, commits: n, notes };
    } else if (m === 'zip') {
      const slug = repoSlug();
      const res = await httpGet(`https://api.github.com/repos/${slug}/contents/package.json?ref=${encodeURIComponent(branch())}`, { headers: { ...apiHeaders(), Accept: 'application/vnd.github.raw+json' } });
      if (res.status !== 200) r = { ok: false, mode: m, version, msg: res.status === 404 ? `저장소(${slug})를 읽지 못했습니다 — 비공개 저장소면 update_token.txt 에 읽기 전용 토큰을 넣으세요` : `GitHub 응답 ${res.status || '없음(인터넷 연결 확인)'}` };
      else {
        const latest = JSON.parse(res.body).version || '';
        r = { ok: true, mode: m, version, latest, behind: cmpVer(latest, version) > 0, notes: '' };
      }
    } else r = { ok: false, mode: m, version, msg: 'git 으로 받은 폴더가 아니고 writer_config.json 의 update.repo 도 비어 있습니다' };
  } catch (e) {
    r = { ok: false, mode: m, version, msg: String(e.stderr || e.message || e).trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 300) };
  }
  LAST = { ...r, checkedAt: new Date().toISOString() };
  return r;
}
function lastCheck() { return LAST; }

function depsOf(file) { try { return JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')).dependencies || {}); } catch { return ''; } }
function npmInstall(log) {
  log('패키지 설치(npm install) ...');
  const r = spawnSync('npm install --omit=dev --no-audit --no-fund', { cwd: ROOT, shell: true, encoding: 'utf8', windowsHide: true, timeout: 10 * 60000 });
  if (r.status !== 0) { log('! npm install 실패: ' + String(r.stderr || r.stdout || '').trim().split(/\r?\n/).slice(-3).join(' / ').slice(0, 300)); return false; }
  log('패키지 설치 완료');
  return true;
}

function copyTree(src, dst) {
  let n = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) { if (e.name === '.git' || e.name === 'node_modules') continue; fs.mkdirSync(d, { recursive: true }); n += copyTree(s, d); }
    else { fs.copyFileSync(s, d); n++; }
  }
  return n;
}

// ── 적용 ──
async function apply(log = console.log) {
  const before = localVersion();
  const depsBefore = depsOf(path.join(ROOT, 'package.json'));
  const m = mode();
  try {
    if (m === 'git') {
      git(['fetch', '--quiet', 'origin', branch()]);
      const n = parseInt(git(['rev-list', '--count', `HEAD..origin/${branch()}`]), 10) || 0;
      if (!n) { LAST = { ...LAST, ok: true, behind: false, version: before, latest: before }; return { ok: true, changed: false, version: before }; }
      // 저장소 파일을 이 PC 에서 고친 것이 있으면 덮어쓰지 않고 따로 보관(stash)해 둔다
      const dirty = git(['status', '--porcelain', '--untracked-files=no']);
      if (dirty) { log('이 PC 에서 고친 프로그램 파일이 있어 따로 보관합니다(git stash): ' + dirty.split(/\r?\n/).map(l => l.trim().replace(/^\S+\s+/, '')).join(', ').slice(0, 200)); git(['stash', 'push', '-m', 'medi-auto update ' + new Date().toISOString()]); }
      log(`새 변경 ${n}건을 받습니다(git pull) ...`);
      git(['merge', '--ff-only', `origin/${branch()}`]);
    } else if (m === 'zip') {
      const c = await check();
      if (!c.ok) return { ok: false, msg: c.msg };
      if (!c.behind) return { ok: true, changed: false, version: before };
      const slug = repoSlug();
      log(`새 버전 v${c.latest} 을 내려받습니다 (${slug}) ...`);
      const res = await httpGet(`https://api.github.com/repos/${slug}/zipball/${encodeURIComponent(branch())}`, { binary: true, headers: apiHeaders() });
      if (res.status !== 200 || res.body.length < 10000) return { ok: false, msg: `내려받기 실패(HTTP ${res.status})` };
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'medi-auto-upd-'));
      const zip = path.join(tmp, 'src.zip'), out = path.join(tmp, 'x');
      fs.writeFileSync(zip, res.body);
      const ps = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${out}' -Force`], { encoding: 'utf8', windowsHide: true, timeout: 5 * 60000 });
      if (ps.status !== 0) return { ok: false, msg: '압축 풀기 실패: ' + String(ps.stderr || '').slice(0, 200) };
      const top = fs.readdirSync(out).map(n => path.join(out, n)).find(p => fs.statSync(p).isDirectory());
      if (!top || !fs.existsSync(path.join(top, 'writer.js'))) return { ok: false, msg: '내려받은 파일 구성이 예상과 다릅니다' };
      const n = copyTree(top, ROOT);
      log(`프로그램 파일 ${n}개를 바꿨습니다`);
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    } else return { ok: false, msg: 'git 으로 받은 폴더가 아니고 writer_config.json 의 update.repo 도 비어 있어 업데이트할 수 없습니다' };
  } catch (e) {
    return { ok: false, msg: String(e.stderr || e.message || e).trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300) };
  }
  if (depsOf(path.join(ROOT, 'package.json')) !== depsBefore || !fs.existsSync(path.join(ROOT, 'node_modules'))) npmInstall(log);
  const after = localVersion();
  LAST = { ok: true, mode: m, version: after, latest: after, behind: false, checkedAt: new Date().toISOString() };
  return { ok: true, changed: true, version: after, from: before };
}

module.exports = { check, apply, lastCheck, localVersion, mode, repoSlug };

if (require.main === module) {
  const cmd = process.argv[2] || 'check';
  (async () => {
    if (cmd === 'apply') {
      const r = await apply((m) => console.log('[update] ' + m));
      console.log(r.ok ? (r.changed ? `[update] updated v${r.from} -> v${r.version}` : `[update] already up to date (v${r.version})`) : '[update] skipped: ' + r.msg);
    } else {
      const r = await check();
      console.log(r.ok ? (r.behind ? `[update] new version available: v${r.version} -> v${r.latest}` : `[update] up to date (v${r.version})`) : '[update] check failed: ' + r.msg);
    }
    process.exit(0);   // 업데이트 실패가 프로그램 시작을 막지 않게 항상 0
  })();
}
