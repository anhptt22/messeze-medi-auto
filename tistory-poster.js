// tistory-poster.js — 메세지 티스토리 발행기 (redtrans-tistory-auto watcher.js 이식판)
// queue_tistory.json 의 pending 원고를 각 티스토리 블로그(trevitykr·trevity02·trevity03)에 올린다.
// 사용법: node tistory-poster.js [draft|ptest|publish] [파일명.html] [숫자=글 간격(분)]
//   draft=임시저장 · ptest=비공개 발행(테스트) · publish=공개 발행(영문 슬러그 적용)
// 이미지 마커: [[IMG: <드라이브 파일ID> | alt]] → 드라이브에서 내려받아 webp 변환 후 티스토리에 업로드.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// playwright-core: 자기 폴더 → 레드트랜스 → 윈차이나 순으로 탐색(메세지 login.js 와 동일한 공유 방식)
function requirePlaywright() {
  const tries = [
    'playwright-core',
  ];
  for (const t of tries) { try { return require(t); } catch {} }
  throw new Error('playwright-core 를 찾지 못했습니다 — 프로그램 폴더에서 npm install 을 실행하세요');
}
const { chromium } = requirePlaywright();

const CFG = require('./config').load();
const T = CFG.tistory || {};
const SESSION_DIR = T.sessionDir || path.join(__dirname, 'tistory-session');
const USER_DATA_DIR = path.join(SESSION_DIR, 'chrome-profile');
const AUTH_FILE = path.join(SESSION_DIR, 'auth.json');
const POSTS_DIR = path.join(__dirname, 'posts');
const QUEUE_FILE = path.join(__dirname, 'queue_tistory.json');
const CATS_FILE = path.join(__dirname, 'categories_tistory.json');
const TMP = path.join(__dirname, 'tmp');
const LOGIN_WAIT_MS = 10 * 60000;

// ── 인자: 모드 키워드는 위치 무관(레드트랜스에서 PowerShell 빈 인자 삭제 사고 교훈) ──
const MODES = ['draft', 'publish', 'ptest'];
const argv = process.argv.slice(2).filter(Boolean);
const MODE = argv.find(a => MODES.includes(a)) || 'draft';
const ONLY_FILE = argv.find(a => a.endsWith('.html'));
// --edit=<entryId>: 이미 발행된 글을 같은 주소로 다시 채워 발행(본문 유실 사고 복구용). 파일 지정 필수.
const EDIT_ID = (argv.find(a => a.startsWith('--edit=')) || '').split('=')[1] || '';
const STAGGER_MIN = parseInt(argv.find(a => /^\d+$/.test(a)) ?? String(T.publishStaggerMin ?? 5), 10);
console.log(`MODE=${MODE}${ONLY_FILE ? ` | FILE=${ONLY_FILE}` : ' | (오늘 pending, 블로그당 최신 1건)'}${EDIT_ID ? ` | 기존 글 수정(entryId=${EDIT_ID})` : ''} | 간격 ${STAGGER_MIN}분`);

function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
const todayCompact = today().replace(/-/g, '');

let CATEGORIES = {};
try { CATEGORIES = JSON.parse(fs.readFileSync(CATS_FILE, 'utf8')); } catch {}

function loadQueue() { try { return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch { return { posts: [] }; } }
function saveQueue(q) { fs.writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2), 'utf8'); }

// ── 게시 대상 선정: queue_tistory.json 기준 ──
function targetItems(q) {
  // --edit 는 상태 무관(published 재수정 허용)
  if (EDIT_ID && ONLY_FILE) return (q.posts || []).filter(p => p.file === path.basename(ONLY_FILE));
  let items = (q.posts || []).filter(p => p.status === 'pending' || (MODE !== 'draft' && p.status === 'draft'));
  if (ONLY_FILE) return items.filter(p => p.file === path.basename(ONLY_FILE));
  items = items.filter(p => (p.file || '').startsWith('medi_tistory' + todayCompact + '_'));
  const byAcct = {};
  for (const p of items) byAcct[p.account] = p; // 큐 순서 = 과거→최신, 마지막이 최신
  const chosen = new Set(Object.values(byAcct).map(x => x.file));
  const dropped = items.filter(p => !chosen.has(p.file));
  if (dropped.length) console.log(`(건너뜀 ${dropped.length}건: 블로그당 최신 1건만 — ${dropped.map(d => d.file).join(', ')})`);
  return items.filter(p => chosen.has(p.file));
}

// ── META 주석(제목·태그·카테고리·슬러그 운반) ──
const META_RE = /<!--\s*META\s*([\s\S]*?)-->/;
function extractMeta(html) { const m = html.match(META_RE); if (!m) return null; try { return JSON.parse(m[1].trim()); } catch { return null; } }
function stripMeta(html) { return html.replace(META_RE, '').replace(/<!--\s*자가 채점[\s\S]*?-->/, '').replace(/^\s+/, ''); }
function markerList(html) {
  const out = []; const re = /\[\[IMG:\s*([^|\]]+?)\s*(?:\|\s*([^\]]*?))?\]\]/g; let m;
  while ((m = re.exec(html))) out.push({ file: m[1].trim(), alt: (m[2] || '').trim() });
  return out;
}

// 이미지: 로컬 파일이면 그대로, 아니면 드라이브 파일ID로 간주해 다운로드 + webp 변환
async function resolveImage(ref, tag) {
  for (const c of [path.join(POSTS_DIR, ref), path.join(TMP, ref), ref]) { try { if (ref.includes('.') && fs.existsSync(c)) return c; } catch {} }
  if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });
  const bin = path.join(TMP, `${tag}.bin`); const webp = path.join(TMP, `${tag}.webp`);
  const r = await fetch(`https://drive.google.com/uc?export=download&id=${ref}`, { redirect: 'follow', signal: AbortSignal.timeout(90000) });
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf[0] === 0x3c) throw new Error('drive-not-image id=' + ref);
  fs.writeFileSync(bin, buf);
  try {
    execSync(`ffmpeg -y -i "${bin}" -vf "scale='min(1200,iw)':-2" "${webp}"`, { stdio: 'ignore' });
    if (fs.existsSync(webp) && fs.statSync(webp).size > 1000) { fs.unlinkSync(bin); return webp; }
  } catch {}
  const jpg = path.join(TMP, `${tag}.jpg`);
  fs.renameSync(bin, jpg);
  return jpg;
}

// 외부 실사 링크(Pexels·Unsplash) → 내려받아 webp(최대 1200px) 로 변환
async function downloadExternal(url, tag) {
  if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });
  const bin = path.join(TMP, `${tag}.bin`); const webp = path.join(TMP, `${tag}.webp`);
  const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60000), headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'image/*' } });
  if (!r.ok) throw new Error(`ext-image http ${r.status} ${url.slice(0, 80)}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 5000 || buf[0] === 0x3c) throw new Error('ext-not-image ' + url.slice(0, 80));
  fs.writeFileSync(bin, buf);
  try {
    execSync(`ffmpeg -y -i "${bin}" -vf "scale='min(1200,iw)':-2" "${webp}"`, { stdio: 'ignore' });
    if (fs.existsSync(webp) && fs.statSync(webp).size > 1000) { fs.unlinkSync(bin); return webp; }
  } catch {}
  const jpg = path.join(TMP, `${tag}.jpg`);
  fs.renameSync(bin, jpg);
  return jpg;
}

const toEnd = () => { const ed = window.tinymce.get('editor-tistory'); ed.focus(); ed.selection.select(ed.getBody(), true); ed.selection.collapse(false); };

// CTA 박스가 최상위 래퍼 테이블 안(td)에 있으면 밖으로(티스토리 에디터가 td 안 p 를 눌러 여백이 사라지는 문제).
// 프롬프트가 CTA·스키마를 래퍼 밖에 쓰도록 지시하므로 이건 안전망. CTA는 스키마 직전 마지막 요소라는 전제.
function fixCtaOutsideTable(html) {
  const m = html.match(/<table[^>]*>\s*<tr>\s*<td style="background-color:#fff0f3; border-top:4px solid #fa6781/);
  if (!m) return html;
  const ctaIdx = m.index;
  const before = html.slice(0, ctaIdx);
  const depth = (before.match(/<table/g) || []).length - (before.match(/<\/table>/g) || []).length;
  if (depth < 1) return html; // 이미 래퍼 밖
  const scriptIdx = html.indexOf('<script', ctaIdx);
  const tail = scriptIdx === -1 ? html.length : scriptIdx;
  const seg = html.slice(ctaIdx, tail);
  const closes = [...seg.matchAll(/<\/td>\s*<\/tr>\s*<\/table>/g)];
  if (!closes.length) return html;
  const last = closes[closes.length - 1]; // CTA 뒤~스키마 앞의 마지막 닫힘 = 래퍼의 닫힘
  console.log('  CTA 박스가 래퍼 테이블 안에 있어 밖으로 이동');
  const newSeg = seg.slice(0, last.index) + seg.slice(last.index + last[0].length);
  return before + '</td></tr></table>\n\n' + newSeg + html.slice(tail);
}

async function waitEditor(page) {
  await page.waitForFunction(
    () => window.tinymce && window.tinymce.get('editor-tistory') && window.tinymce.get('editor-tistory').getBody(),
    null, { timeout: 20000 });
}

async function uploadOne(page, fp) {
  await waitEditor(page);
  // 업로드 전 에디터에 있던 사진 주소 집합 — 새 사진은 '전후 차집합' 으로 찾는다 ('마지막 img' 방식은 커서 위치에 따라 옛 사진을 집었다)
  const beforeSet = await page.evaluate(() => [...window.tinymce.get('editor-tistory').getBody().querySelectorAll('img')].map(i => i.getAttribute('src') || ''));
  await page.evaluate(toEnd);
  // 1차: 툴바 좌표 클릭 → '사진' 메뉴. 2026-10-14: 상단 알림 띠 등으로 좌표가 빗나가면 파일 선택창이 안 열려 사진 0장으로 발행됐음 → 선택자 클릭으로 재시도
  const openChooser = async (how) => {
    if (how === 'coord') { await page.mouse.click(292, 35); }
    else { await page.locator('button[aria-label*="사진"], button[title*="사진"], .mce-btn:has-text("사진"), [class*="btn_photo"], button:has-text("사진")').first().click({ timeout: 3000 }).catch(() => {}); }
    await page.waitForTimeout(700);
    const [fc] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 6000 }).catch(() => null),
      page.locator('.mce-menu-item:has-text("사진"), [role="menuitem"]:has-text("사진")').first().click({ timeout: 3000 }).catch(() => {}),
    ]);
    return fc;
  };
  let fc = await openChooser('coord');
  if (!fc) { await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(500); fc = await openChooser('selector'); }
  if (!fc) { console.log('  upload_err: 파일 선택창이 열리지 않음(툴바 좌표·선택자 모두 실패) — 에디터 상단 레이아웃 확인'); return null; }
  await fc.setFiles(fp);
  const before = new Set(beforeSet);
  for (let t = 0; t < 20; t++) {
    await page.waitForTimeout(700);
    const srcs = await page.evaluate(() => [...window.tinymce.get('editor-tistory').getBody().querySelectorAll('img')].map(i => i.getAttribute('src') || ''));
    const fresh = srcs.filter(u => u && /^https?:/.test(u) && !before.has(u));
    if (fresh.length) return fresh[fresh.length - 1];
  }
  console.log('  upload_err: 파일은 넣었지만 에디터에 새 사진이 나타나지 않음(14초 대기)');
  return null;
}

async function postOne(page, item) {
  const fp = path.join(POSTS_DIR, item.file);
  if (!fs.existsSync(fp)) throw new Error('파일 없음: ' + item.file);
  const html = fixCtaOutsideTable(fs.readFileSync(fp, 'utf8'));
  const meta = extractMeta(html) || {};
  const account = item.account;
  if (!account) throw new Error('큐 항목에 account 없음: ' + item.file);
  const title = meta.headline || item.title || '제목';
  const editorUrl = EDIT_ID ? `https://${account}.tistory.com/manage/newpost/${EDIT_ID}` : `https://${account}.tistory.com/manage/newpost/`;
  await page.goto(editorUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  await page.getByRole('button', { name: /취소|아니오|닫기/ }).first().click({ timeout: 1500 }).catch(() => {});
  // 에디터가 뜨는지로 로그인 판정(카카오 SSO 중간 리다이렉트 오탐 방지)
  try { await waitEditor(page); }
  catch (e) {
    const isLogin = /auth\/login|accounts\.kakao|tistory\.com\/auth/.test(page.url());
    if (!isLogin) throw new Error('에디터 로딩 실패(url=' + page.url().slice(0, 80) + ')');
    console.log('  티스토리 로그인이 필요합니다. 열린 창에서 카카오로 로그인해 주세요(최대 10분 대기)...');
    const deadline = Date.now() + LOGIN_WAIT_MS;
    let recovered = false;
    while (Date.now() < deadline) {
      await page.waitForTimeout(3000).catch(() => {});
      if (page.isClosed && page.isClosed()) break;
      const u = page.url();
      if (!/auth\/login|accounts\.kakao|tistory\.com\/auth/.test(u)) {
        await page.goto(`https://${account}.tistory.com/manage/newpost/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForTimeout(4000);
        await page.getByRole('button', { name: /취소|아니오|닫기/ }).first().click({ timeout: 1500 }).catch(() => {});
        try { await waitEditor(page); recovered = true; break; } catch {}
      }
    }
    if (!recovered) throw new Error('티스토리 로그인 대기 시간 초과(10분) — 다시 실행해 주세요');
    console.log('  로그인 확인됨. 계속 진행합니다.');
    try { await page.context().storageState({ path: AUTH_FILE }); } catch {}
    if (EDIT_ID) { await page.goto(editorUrl, { waitUntil: 'domcontentloaded' }).catch(() => {}); await page.waitForTimeout(4000); }
  }
  await page.getByRole('button', { name: /취소|아니오|닫기/ }).first().click({ timeout: 1500 }).catch(() => {});
  await page.fill('#post-title-inp', title).catch(() => {});

  // 1) 이미지 먼저 업로드(임시 본문에) → 티스토리 URL 확보
  const markers = markerList(html);
  await waitEditor(page);
  await page.evaluate(() => window.tinymce.get('editor-tistory').setContent('<p></p>'));
  const urls = [];
  for (let k = 0; k < markers.length; k++) {
    let src = null;
    for (let tryN = 1; tryN <= 2 && !src; tryN++) {
      try { const f = await resolveImage(markers[k].file, `${account}_${k + 1}`); src = await uploadOne(page, f); }
      catch (e) { console.log(`  img_err(${tryN}차):`, e.message.split('\n')[0].slice(0, 140)); if (tryN === 1) await page.waitForTimeout(2000); }
    }
    urls.push({ src, alt: markers[k].alt });
  }

  // 1-b) 본문 속 외부 실사 링크(Pexels·Unsplash) → 내려받아 티스토리에 올리고 주소를 바꾼다.
  //   링크만 걸린 사진은 티스토리가 '첨부 이미지'로 치지 않아 대표 이미지(썸네일)가 안 생기고, Pexels 가 지우면 글에서 사라진다.
  //   로컬 사진(대시보드 미리보기 주소 http://localhost:5012/post-img/<파일> = posts\_img\<파일>, 홈페이지 화면 캡처 등)도 같은 방식으로 올린다.
  const LOCAL_IMG_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/post-img\/([^"?#]+)/;
  const extImgs = [];
  for (const m of html.matchAll(/<img\b[^>]*\bsrc="(https?:\/\/(?:images\.(?:pexels|unsplash)\.com|(?:localhost|127\.0\.0\.1):\d+\/post-img)\/[^"]+)"[^>]*>/g)) {
    const src = m[1];
    if (extImgs.some(e => e.src === src)) continue;
    const lm = src.match(LOCAL_IMG_RE);
    extImgs.push({ src, alt: (m[0].match(/alt="([^"]*)"/) || [])[1] || '', local: lm ? path.join(POSTS_DIR, '_img', path.basename(decodeURIComponent(lm[1]))) : '' });
  }
  const extMap = new Map();
  for (let k = 0; k < extImgs.length; k++) {
    const e = extImgs[k];
    let up = null;
    for (let tryN = 1; tryN <= 2 && !up; tryN++) {
      try {
        if (e.local && !fs.existsSync(e.local)) throw new Error('로컬 사진 파일 없음: ' + e.local);
        const f = e.local || await downloadExternal(e.src, `${account}_ext${k + 1}`);
        up = await uploadOne(page, f);
      } catch (err) { console.log(`  ext_img_err(${tryN}차):`, err.message.split('\n')[0].slice(0, 140)); if (tryN === 1) await page.waitForTimeout(2000); }
    }
    if (up) { extMap.set(e.src, up); urls.push({ src: up, alt: e.alt }); console.log(`  ${e.local ? '로컬' : '외부'} 사진 업로드 ${k + 1}/${extImgs.length}: ${up.slice(0, 70)}`); }
    else if (e.local) throw new Error('로컬 사진 업로드 실패 — 내 PC 주소가 글에 남으면 안 되므로 발행을 중단합니다: ' + path.basename(e.local));
    else console.log(`  외부 사진 업로드 실패 — 원래 링크 유지: ${e.src.slice(0, 90)}`);
  }

  // 2) 마커를 <img>로 치환한 최종 HTML 을 한 번에 주입(META·채점 주석은 제거)
  let idx = 0, used = 0;
  let finalHtml = stripMeta(html).replace(/\[\[IMG:[^\]]*\]\]/g, () => {
    const u = urls[idx++];
    if (u && u.src) { used++; return `<p><img src="${u.src}" alt="${(u.alt || '').replace(/["<>]/g, '')}" style="max-width:100%;height:auto;"></p>`; }
    return '';
  });
  if (extMap.size) finalHtml = finalHtml.replace(/src="([^"]+)"/g, (m0, s) => extMap.has(s) ? `src="${extMap.get(s)}"` : m0);
  const extUsed = extMap.size;
  await page.evaluate(() => window.tinymce.get('editor-tistory').setContent(''));
  await page.waitForTimeout(300);
  await page.evaluate((h) => window.tinymce.get('editor-tistory').setContent(h), finalHtml);
  await page.waitForTimeout(800);
  await page.evaluate(() => { const ed = window.tinymce.get('editor-tistory'); if (ed.save) ed.save(); });
  await page.waitForTimeout(500);
  // 본문 주입 검증 — 빈 글 저장 방지
  const bodyLen = await page.evaluate(() => window.tinymce.get('editor-tistory').getBody().innerText.trim().length);
  if (bodyLen < 500) throw new Error(`본문 주입 실패(에디터 텍스트 ${bodyLen}자) — 저장 중단`);
  // alt 검증·복원(검색엔진·AI는 alt 로 판단)
  const altInfo = await page.evaluate((pairs) => {
    const imgs = Array.from(window.tinymce.get('editor-tistory').getBody().querySelectorAll('img'));
    let restored = 0;
    imgs.forEach((im) => {
      const cur = (im.getAttribute('alt') || '').trim();
      if (cur.length > 5) return;
      const src = im.getAttribute('src') || '';
      const hit = pairs.find(p => p.src && src.includes(p.src.split('/').pop().split('?')[0]));
      if (hit && hit.alt) { im.setAttribute('alt', hit.alt); restored++; }
    });
    if (restored) { const ed = window.tinymce.get('editor-tistory'); if (ed.save) ed.save(); }
    const after = Array.from(window.tinymce.get('editor-tistory').getBody().querySelectorAll('img'));
    return { n: after.length, withAlt: after.filter(i => (i.getAttribute('alt') || '').trim().length > 5).length, restored };
  }, urls.filter(u => u && u.src));
  console.log(`  alt: ${altInfo.withAlt}/${altInfo.n}${altInfo.restored ? ` (${altInfo.restored}개 복원)` : ''}`);

  // ★★에디터 앱 상태 동기화 강제 (2026-08-13 trevity03 본문 유실 사고 대책)
  //   setContent 만으로는 티스토리 에디터 앱(React)이 본문 변경을 인지하지 못해, 발행 시
  //   자동저장 스냅샷(이미지 업로드 중간 상태 = 이미지만 있는 본문)이 올라가는 일이 있었다.
  //   → change/input 이벤트 발화 + 실제 키 입력(공백 입력 후 삭제)으로 앱의 변경 감지를 확정 트리거한다.
  await page.evaluate(() => {
    const ed = window.tinymce.get('editor-tistory');
    try { ed.fire('change'); ed.fire('input'); ed.fire('keyup'); } catch {}
    try { ed.undoManager && ed.undoManager.add && ed.undoManager.add(); } catch {}
    try { ed.getBody().dispatchEvent(new Event('input', { bubbles: true })); } catch {}
    if (ed.save) ed.save();
  });
  await page.evaluate(toEnd);
  await page.keyboard.type(' ');
  await page.waitForTimeout(400);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(800);
  await page.evaluate(() => { const ed = window.tinymce.get('editor-tistory'); if (ed.save) ed.save(); });

  // 3) 해시태그(META keywords → #tagText, 최대 10개)
  const tags = (meta.keywords ? String(meta.keywords).split(',') : []).map(t => t.trim()).filter(Boolean);
  let tagOk = 0;
  if (tags.length) {
    const inp = page.locator('#tagText');
    if (await inp.count()) {
      for (const t of tags.slice(0, 10)) {
        try {
          await inp.click();
          await inp.pressSequentially(t.replace(/^#/, ''), { delay: 15 });
          await inp.press('Enter');
          await page.waitForTimeout(250);
          tagOk++;
        } catch (e) { console.log('  tag_err:', t, e.message.slice(0, 40)); }
      }
    }
  }

  // 4) 카테고리(META articleSection → categories_tistory.json 의 id)
  const section = (meta.articleSection || item.category || '').trim();
  let catOk = false;
  if (section) {
    // 이름 매칭은 관대하게: 공백·중점·괄호 글 수 표기(예: "제품 체험단 (3)") 차이로 실패하지 않게 정규화 후 비교.
    const norm = (s) => String(s || '').replace(/\(\s*\d+\s*\)\s*$/, '').replace(/[\s·・‧]/g, '').toLowerCase();
    const list = CATEGORIES[account] || [];
    const want = norm(section);
    const cat = list.find(c => norm(c.name) === want)
      || list.find(c => norm(c.name).includes(want) || want.includes(norm(c.name)));
    if (!cat) console.log('  cat_warn: 목록에 없는 카테고리', section, '| 목록:', list.map(c => c.name).join('/') || '(비어 있음 — 카테고리 추출 필요)');
    else if (!cat.id) console.log('  cat_warn: 카테고리 id 미확보(' + section + ') — [카테고리 추출]을 실행하면 다음부터 자동 선택됨');
    else {
      try {
        await page.locator('#category-btn').click({ timeout: 5000 });
        await page.locator(`#category-item-${cat.id}`).waitFor({ state: 'visible', timeout: 8000 });
        await page.locator(`#category-item-${cat.id}`).click();
        await page.waitForTimeout(500);
        catOk = true;
      } catch (e) { console.log('  cat_err:', section, e.message.split('\n')[0].slice(0, 60)); }
      if (catOk) console.log(`  cat: ${cat.name} (id ${cat.id})`);
    }
  }

  // ★저장 직전 본문 재검증 — 에디터가 내용을 되돌렸으면 1회 재주입 후 진행
  let lastLen = await page.evaluate(() => window.tinymce.get('editor-tistory').getBody().innerText.trim().length);
  if (lastLen < 500) {
    console.log(`  ! 저장 직전 본문 축소 감지(${lastLen}자) — 재주입`);
    await page.evaluate((h) => { const ed = window.tinymce.get('editor-tistory'); ed.setContent(h); ed.fire('change'); if (ed.save) ed.save(); }, finalHtml);
    await page.evaluate(toEnd);
    await page.keyboard.type(' ');
    await page.waitForTimeout(400);
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(800);
    lastLen = await page.evaluate(() => window.tinymce.get('editor-tistory').getBody().innerText.trim().length);
    if (lastLen < 500) throw new Error(`본문 재주입 실패(${lastLen}자) — 저장 중단`);
  }

  if (MODE === 'draft') {
    await page.locator('button:has-text("임시저장"), a:has-text("임시저장")').first().click().catch(() => {});
    await page.waitForTimeout(3500);
  } else {
    // 2026-10-09: 완료 클릭이 묻혀 발행 레이어가 안 열린 채 진행되던 문제 → 레이어(#urlPublish)가 보일 때까지 최대 4회 재클릭
    let layerOk = false;
    for (let k = 0; k < 4 && !layerOk; k++) {
      await page.locator('button:has-text("완료"), a:has-text("완료")').first().click({ timeout: 5000 }).catch(() => {});
      try { await page.locator('#urlPublish').first().waitFor({ state: 'visible', timeout: 6000 }); layerOk = true; }
      catch { await page.waitForTimeout(1500); }
    }
    if (!layerOk) console.log('  ! 발행 레이어가 열리지 않음(완료 4회 시도) — 그래도 진행');
    await page.waitForTimeout(800);
    const vis = (MODE === 'ptest') ? '비공개' : '공개';
    await page.getByText(vis, { exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(900);
    // 영문 슬러그(#urlPublish) — 안 넣으면 한글 URL
    const slug = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(meta.slug || '') ? meta.slug : (item.slug || '');
    if (slug) {
      const u = page.locator('#urlPublish');
      if (await u.count().catch(() => 0)) {
        await u.fill(slug).catch(() => {});
        const got = await u.inputValue().catch(() => '');
        console.log(got === slug ? `  slug: ${got}` : `  slug_warn: 입력값 "${got}" != "${slug}"`);
      } else console.log('  slug_warn: #urlPublish 없음 — 한글 URL로 나갈 수 있음');
    } else console.log('  slug_warn: slug 없음 — 한글 URL로 나갈 수 있음');
    await page.getByRole('button', { name: /발행|저장/ }).last().click().catch(() => {});
    // 저장이 오래 걸리는 글 대비: 에디터를 벗어날 때까지 최대 60초 폴링
    // ★티스토리가 자동입력 방지 문제(DKAPTCHA — 지도에서 장소 이름 빈칸 채우기)를 띄우면 프로그램은 풀지 않는다.
    //   사람이 열린 창에서 직접 답을 넣을 때까지 최대 10분 기다렸다가 이어서 진행한다.
    // 2026-10-08: 캡차 모달이 iframe 안에 떠서 본문 innerText 만 보면 못 잡았음 → 모든 프레임 + captcha 요소까지 확인
    const CAPTCHA_RE = /DKAPTCHA|정답을 입력해주세요|빈칸에 들어갈 글자|전체 명칭을 입력|자동입력 방지/;
    const hasCaptcha = async () => {
      for (const fr of page.frames()) {
        try {
          if (/captcha/i.test(fr.url())) return true;
          const hit = await fr.evaluate((re) => {
            if (new RegExp(re).test(document.body ? (document.body.innerText || '') : '')) return true;
            return !!document.querySelector('[class*="captcha" i], [id*="captcha" i], iframe[src*="captcha" i], input[placeholder*="정답"]');
          }, CAPTCHA_RE.source);
          if (hit) return true;
        } catch {}
      }
      return false;
    };
    let captchaSeen = false;
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(2000);
      if (!/\/manage\/newpost\//.test(page.url())) break;
      if (!captchaSeen && await hasCaptcha()) {
        captchaSeen = true;
        console.log('  ★티스토리 자동입력 방지 문제가 떴습니다 — 열린 크롬 창에서 지도 속 장소 이름의 빈칸 글자를 직접 입력하고 [답변 제출]을 눌러 주세요 (최대 10분 대기).');
        for (let w = 0; w < 300; w++) { // 2초 × 300 = 10분
          await page.waitForTimeout(2000);
          if (!/\/manage\/newpost\//.test(page.url())) break;
          if (!(await hasCaptcha())) break;
        }
        if (/\/manage\/newpost\//.test(page.url())) {
          if (await hasCaptcha()) throw new Error('자동입력 방지 문제를 10분 안에 풀지 못했습니다 — [발행]을 다시 눌러 주세요');
          console.log('  자동입력 방지 통과 — 발행을 이어서 진행합니다.');
          await page.waitForTimeout(1500);
          // 문제를 풀면 대개 저장이 이어지지만, 발행 창으로 돌아와 있으면 [발행]을 한 번 더 누른다
          if (/\/manage\/newpost\//.test(page.url())) await page.getByRole('button', { name: /발행|저장/ }).last().click().catch(() => {});
          i = 0; // 저장 대기 60초를 다시 준다
        }
      }
    }
    if (/\/manage\/newpost\//.test(page.url())) {
      await page.screenshot({ path: path.join(__dirname, `tistory_fail_${account}.png`), fullPage: false }).catch(() => {});
      const diag = await page.evaluate(() => {
        const vis2 = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const layers = [...document.querySelectorAll('[class*="layer"],[class*="popup"],[class*="modal"],[role="dialog"],[class*="alert"]')]
          .filter(vis2).map(el => (el.innerText || '').replace(/\s+/g, ' ').trim()).filter(t => t && t.length < 400);
        return [...new Set(layers)].slice(0, 5);
      }).catch(() => []);
      console.log('  진단 팝업:', JSON.stringify(diag));
      throw new Error(`발행 실패 — 에디터를 벗어나지 못함. tistory_fail_${account}.png 확인`);
    }
  }
  let postUrl = '';
  if (MODE !== 'draft') {
    const slugForUrl = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(meta.slug || '') ? meta.slug : (item.slug || '');
    if (slugForUrl) postUrl = `https://${account}.tistory.com/entry/${slugForUrl}`;
    else {
      const u0 = page.url();
      if (/^https?:\/\/[^/]+\.tistory\.com\//.test(u0) && !/\/manage/.test(u0)) postUrl = u0;
    }
  }
  // ★발행 후 실물 검증 — 발행된 페이지를 실제로 받아 본문 텍스트가 있는지 확인(빈 글 발행 사고 감지)
  if (MODE === 'publish' && postUrl) {
    await page.waitForTimeout(5000);
    try {
      const r = await fetch(postUrl, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
      const html = await r.text();
      const i = html.indexOf('tt_article_useless_p_margin');
      const seg = i !== -1 ? html.slice(i, i + 100000) : html;
      const txt = seg.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, '');
      const imgN2 = (seg.match(/<img /g) || []).length;
      console.log(`  발행 검증: 텍스트 ${txt.length}자 · 이미지 ${imgN2}장`);
      if (i !== -1 && txt.length < 800) throw new Error(`발행 본문 검증 실패(텍스트 ${txt.length}자) — 발행 글이 비었습니다. --edit=<entryId> 로 재주입 필요`);
    } catch (e) {
      if (/검증 실패/.test(e.message)) throw e;
      console.log('  발행 검증 생략(페이지 조회 실패): ' + e.message.slice(0, 60));
    }
  }
  return { account, title, url: postUrl, imgN: markers.length + extImgs.length, imgOk: used + extUsed, tagN: tags.length, tagOk, section, catOk };
}

(async () => {
  const q = loadQueue();
  const items = targetItems(q);
  if (!items.length) { console.log('게시할 티스토리 글이 없습니다(오늘 pending 없음).'); process.exit(0); }
  console.log(`게시 시작: ${items.length}건 | 모드=${MODE}`);
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false, channel: 'chrome', viewport: { width: 1440, height: 900 }, args: ['--start-maximized'],
  });
  try {
    const cookies = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')).cookies || [];
    if (cookies.length) await ctx.addCookies(cookies);
  } catch (e) { console.log('auth.json 쿠키 주입 실패(최초 실행이면 로그인 창에서 로그인):', e.message.slice(0, 60)); }
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.on('dialog', async (d) => {
    const msg = d.message();
    console.log('  [DIALOG]', d.type(), msg.slice(0, 150));
    // ★임시저장 글 복원 확인창은 '취소' — 수락하면 예전 실패 때 남은 임시글이 에디터에 복원되고, 사진 매핑이 그 옛 사진을 집어
    //   다른 글의 사진이 들어가는 사고가 난다(2026-10-13 바우처통 두 글 썸네일 동일). 빈 에디터에서 새로 채우는 것이 항상 안전하다.
    if (d.type() === 'confirm' && /저장된 글|이어서 작성|임시 ?저장/.test(msg)) { console.log('  → 임시글 복원 안 함(취소)'); await d.dismiss().catch(() => {}); return; }
    await d.accept().catch(() => {});
  });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let fails = 0;
  for (let fi = 0; fi < items.length; fi++) {
    const it = items[fi];
    try {
      const r = await postOne(page, it);
      // 큐 상태 갱신(디스크에서 새로 읽어 병합 — writer 쪽 변경 보호)
      const q2 = loadQueue();
      const hit = (q2.posts || []).find(p => p.file === it.file);
      if (hit) {
        if (MODE === 'draft') hit.status = 'draft';
        else { hit.status = 'published'; hit.published_url = r.url || ''; hit.posted_at = new Date().toISOString(); }
        saveQueue(q2);
      }
      console.log(`OK ${r.account} [${MODE}] (img ${r.imgOk}/${r.imgN}, tag ${r.tagOk}/${r.tagN}, cat:${r.catOk ? r.section : '없음'}) | ${r.title.slice(0, 30)}${r.url ? ' | ' + r.url : ''}`);
    } catch (e) { fails++; console.log('FAIL', it.file, '|', e.message.slice(0, 90)); }
    if (MODE !== 'draft' && fi < items.length - 1) { console.log(`... 다음 발행까지 ${STAGGER_MIN}분 대기`); await sleep(STAGGER_MIN * 60000); }
  }
  await ctx.storageState({ path: AUTH_FILE }).catch(() => {});
  await ctx.close();
  console.log(`게시 완료 (실패 ${fails}건)`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
