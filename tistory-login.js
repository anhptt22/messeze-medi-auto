// tistory-login.js — 메세지 카카오(티스토리) 로그인 1회. 성공 확인 후 세션을 auth.json 에 저장.
// 세션 위치는 writer_config.json 의 tistory.sessionDir (기본 E:\6. MESSEZE\trevity-tistory-auto).
// 창이 열리면 [카카오계정으로 로그인]으로 메세지 계정에 직접 로그인만 하면 된다.
const fs = require('fs');
const path = require('path');

function requirePlaywright() {
  const tries = [
    'playwright-core',
  ];
  for (const t of tries) { try { return require(t); } catch {} }
  throw new Error('playwright-core 를 찾지 못했습니다');
}
const { chromium } = requirePlaywright();

const CFG = require('./config').load();
const T = CFG.tistory || {};
const SESSION_DIR = T.sessionDir || path.join(__dirname, 'tistory-session');
const USER_DATA_DIR = path.join(SESSION_DIR, 'chrome-profile');
const AUTH_FILE = path.join(SESSION_DIR, 'auth.json');
const FIRST_ACCOUNT = ((T.blogs || [])[0] || {}).account || 'trevitykr';
const CHECK_URL = `https://${FIRST_ACCOUNT}.tistory.com/manage/newpost/`;

(async () => {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    channel: 'chrome',
    viewport: null,
    args: ['--start-maximized'],
  });

  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://www.tistory.com/auth/login', { waitUntil: 'domcontentloaded' }).catch(() => {});

  console.log('Chrome 로그인 창이 열렸습니다. [카카오계정으로 로그인]으로 메세지 계정에 직접 로그인하세요. 최대 8분.');

  const deadline = Date.now() + 8 * 60 * 1000;
  let ok = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000).catch(() => {});
    const u = safeUrl(page);
    if (u.includes('tistory.com') && !u.includes('/auth/login') && !u.includes('kakao')) {
      await page.goto(CHECK_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(2500).catch(() => {});
      if (!safeUrl(page).includes('/auth/login')) { ok = true; break; }
    }
  }

  if (ok) {
    await ctx.storageState({ path: AUTH_FILE });
    console.log('로그인 성공 — 세션을 auth.json 에 저장했습니다: ' + AUTH_FILE);
  } else {
    console.log('시간 초과 — 로그인이 감지되지 않았습니다. 다시 시도해주세요.');
  }
  await ctx.close().catch(() => {});
  process.exit(ok ? 0 : 2);
})().catch((e) => { console.error('오류:', e); process.exit(1); });

function safeUrl(page) { try { return page.url(); } catch (_) { return ''; } }
