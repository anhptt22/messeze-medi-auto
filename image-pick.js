// image-pick.js — 사진 고르기: 후보 URL 수집 → 실제로 내려받기 → Claude 가 파일을 직접 열어 보고 기준으로 판정
// (URL 이 열리는지만 보던 방식은 사진 속 글자·분위기·주제 적합성을 걸러내지 못했다)
const fs = require('fs');
const path = require('path');
const https = require('https');

const CHECK_DIR = path.join(__dirname, '_img_check');

const CRITERIA = [
  '[사진 기준 — 하나라도 어기면 탈락]',
  '1. 사진 안에 읽히는 글자·숫자·로고·간판이 없을 것 (특히 영어 문구·속어·농담 메모). 배경의 책 표지·포스터 글씨도 알아볼 수 있으면 탈락. 화면 속 홈페이지 레이아웃은 허용하되 그 안의 글자·로고를 알아볼 수 있으면 탈락.',
  '2. 신뢰감 있는 병원·전문 서비스 톤. 장난스러운 소품·밈·과장된 연출·어둡거나 지저분한 장면 탈락.',
  '3. 글 주제와 이어질 것: 그 자리의 소제목·문단이 말하는 장면을 떠올리게 하는 사진. 어느 글에나 붙는 추상 소재(전구·퍼즐·체스말·화살표만 있는 그래프) 지양.',
  '4. 인물 얼굴 클로즈업·카메라를 보는 연출 사진 탈락 (뒷모습·손·원경은 허용).',
  '5. AI 생성 이미지·일러스트·3D 렌더 탈락. 기기·제품의 브랜드 로고(애플 등)는 흐릿해도 알아볼 수 있으면 탈락.',
  '6. 흐림·과한 필터·워터마크 탈락. 커버는 가로 구도.',
  '7. 참고용으로 주어진 최근 글 사진들과 같은 소재·구도(예: 노트북 치는 손이 또 나옴)면 탈락 — 블로그 목록에서 나란히 보여도 구별될 것.',
  '8. 빈티지·레트로 색감(바랜 톤·세피아·필름 필터·누런/갈색 위주의 오래된 느낌)이나 구형 기기가 나오면 탈락 — 밝고 선명한 현대적인 색감일 것.',
  '9. 한국 독자용이다: 사람이 나오면 한국인·동아시아인으로 보이는 사람만. 서양인·다른 인종이 뚜렷하게 보이면(뒷모습·손이라도 알아볼 수 있으면) 탈락. 인물 없는 장면(공간·손·사물)은 허용.',
  '10. 소제목 내용 우선: 그 자리 소제목이 말하는 대상이 사진에 직접 보여야 한다. 예: 영문 홈페이지·페이지 구성 → 그런 사이트가 떠 있는 노트북·모니터 화면, URL·주소 구조 → 브라우저 주소창, 검색 결과 점검 → 검색 화면, 미팅·제안서·자료 검토 → 회의·자료 검토 장면, 비용·견적 → 견적서·자료 위에 계산기를 두고 비용을 따지는 장면, 병원 글의 환자·진료 이야기 → 병원·의료진. 어느 글에나 붙는 일반 회의·사무실·서류 사진이면 탈락. 화면 사진은 화면 속 UI 글자·서비스 로고(구글 등)를 허용한다(1번·5번의 예외 — 단 개인정보·타사 회사명·농담 문구가 크게 읽히면 탈락). 공장 기계·병원 장비 같은 업종 현장 사진은 그 자리 내용과 이어질 때만 통과. 간접 연상으로 고르지 않는다(예: 기자 이야기 → 마이크, 비용 이야기 → 동전·지폐 더미) — 보는 사람이 설명 없이도 그 단락 내용을 떠올릴 수 있어야 한다.',
  '11. 억지로 고르지 않는다: 사진은 글 전체에 2~3장이면 충분하고, 자리마다 꼭 있어야 하는 것이 아니다. 내용에 맞는 후보가 없으면 비슷한 사무 사진으로 채우지 말고 전부 탈락시킨다.',
  '12. 여백: 본문 사진은 가로 사진이면 3:2, 세로 사진이면 1.25:1 틀로 잘라서 쓴다(후보 파일은 이미 잘린 상태다). 잘린 상태에서 주 피사체가 온전히 보이고 화면을 충분히 채워야 한다 — 빈 벽·빈 배경이 절반 이상이거나 피사체가 잘려 나갔으면 탈락. 초점이 맞은 부분이 작고 화면 대부분이 흐릿한(아웃포커스) 사진, 낡고 어수선한 공간이 배경인 사진도 탈락.',
  '13. DeepSeek 앱·웹 화면(파란 고래 로고, "Hi, I\'m DeepSeek" 문구)이 보이는 사진은 쓰지 않는다 — AI 검색·AI 답변을 보여 줘야 하는 자리에는 ChatGPT·Gemini·Copilot·Perplexity·네이버 AI 브리핑처럼 질문에 답하는 AI 화면을 쓴다(2026-10-22 사용자 지시).',
  '15. 병원 전용 블로그다: 병원 로비·접수 데스크·복도·진료실 책상·대기 공간·외관, 병원 홈페이지·지도·검색 화면이 뜬 노트북·휴대폰처럼 병원과 정보가 함께 읽히는 사진을 고른다. 환자의 치료·시술 장면, 주사·수술·혈액·의료기기 클로즈업, 전·후 비교 느낌의 사진은 탈락(의료광고 오해 방지). 동물병원 글은 동물병원 공간·보호자와 반려동물이 기다리는 장면까지 허용(진료·수술 장면 탈락).',
  '14. 설계 도면·청사진·기계 부품 도면·회로도·건축 평면도 같은 선 그림 기술 도식이 크게 보이는 사진은 쓰지 않는다 — 마케팅·홈페이지·콘텐츠 이야기와 맞지 않는다. 규격·사양·인증 자리에는 영문 문서를 읽는 사람, 노트북 화면의 웹페이지, 자료를 정리하는 책상 장면을 쓴다(2026-10-29 사용자 재지시).',
].join('\n');

// 사용자가 화면 사진(서치콘솔·사이트맵·분석 화면 등)을 직접 요청한 경우의 예외
const SCREEN_RE = /화면|스크린|서치콘솔|사이트맵|대시보드|애널리틱스|search console|sitemap|analytics|screen/i;
function criteriaFor(hint) {
  if (!hint || !SCREEN_RE.test(hint)) return CRITERIA;
  return CRITERIA + '\n' + [
    '[★예외 — 사용자가 화면 사진을 요청함]',
    '- 이번에는 노트북·모니터 화면에 요청한 화면(서치콘솔·사이트맵·검색 분석 등)이 실제로 보이는 사진을 고른다.',
    '- 그 화면 속 UI 글자와 해당 서비스(구글 등)의 로고는 허용한다(1번·5번 기준의 예외). 기기 브랜드 로고도 작게 보이는 정도는 허용.',
    '- 단, 화면에 개인정보·타사 회사명·실제 사이트 주소가 크게 읽히는 사진, 영어 농담·슬로건이 적힌 사진은 탈락. 나머지 기준은 그대로.',
    '- 요청한 화면과 무관한 일반 사무실·인물 사진은 이번에는 탈락.',
  ].join('\n');
}

function download(url, file) {
  return new Promise(resolve => {
    let done = false; const fin = v => { if (!done) { done = true; resolve(v); } };
    const go = (u, hops) => {
      const req = https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 20000 }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 3) { res.resume(); return go(new URL(res.headers.location, u).href, hops + 1); }
        if (res.statusCode !== 200 || !/^image\//.test(res.headers['content-type'] || '')) { res.resume(); return fin(false); }
        const out = fs.createWriteStream(file);
        res.pipe(out); out.on('finish', () => out.close(() => fin(fs.statSync(file).size > 5000)));
        out.on('error', () => fin(false));
      });
      req.on('error', () => fin(false)); req.on('timeout', () => { req.destroy(); fin(false); });
    };
    try { go(url, 0); } catch { fin(false); }
  });
}

// 판정용 크기 — 너무 작으면 화면 속 작은 글자를 놓친다 (원본 URL 은 그대로 쓴다)
function smallUrl(u) {
  if (/images\.unsplash\.com/.test(u)) return /[?&]w=\d+/.test(u) ? u.replace(/([?&])w=\d+/, '$1w=1100').replace(/([?&])h=\d+/, '$1h=620') : u + (u.includes('?') ? '&' : '?') + 'w=1100';
  if (/images\.pexels\.com/.test(u)) return u.split('?')[0] + '?auto=compress&w=1100';
  return u;
}

function jsonIn(raw, open) {
  const m = String(raw).match(open === '[' ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// 후보(URL 목록)를 내려받아 Claude 가 직접 보고 고른다 → { url, reason } | null
async function judge({ E, cfg, log, purpose, candidates, used, refs = [], wantAlt = false, hint = '' }) {
  const stamp = Date.now().toString(36);
  const dir = path.join(CHECK_DIR, stamp);
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  const usedB = new Set([...used].map(x => String(x).replace(/&amp;/g, '&').split('?')[0]));
  for (const u of candidates) {
    if (!u || used.has(u) || usedB.has(String(u).split('?')[0]) || files.find(f => f.url === u)) continue;
    const fp = path.join(dir, `c${files.length + 1}.jpg`);
    // 본문 사진(wantAlt)은 실제로 들어갈 잘린 모습 그대로 보고 판정한다
    // 커버는 사진 전체(3:2)를 보고 판정한다 — 피사체 위치(fx, fy)를 받아 그 자리가 띠 한가운데에 오도록 자른다
    if (await download(wantAlt ? await smartInlineUrl(u, { E, cfg, log }, 1100) : coverUrl(u.split('?')[0], 1100), fp)) files.push({ url: u, fp });
    else log && log('  열리지 않는 후보 제외: ' + u);
    if (files.length >= 6) break;
  }
  if (!files.length) return null;
  const refFiles = [];
  for (const u of refs) {
    const fp = path.join(dir, `ref${refFiles.length + 1}.jpg`);
    if (await download(smallUrl(u), fp)) refFiles.push(fp);
    if (refFiles.length >= 4) break;
  }
  const prompt = [
    `다음은 ${purpose} 후보 사진 ${files.length}장이다. 각 파일을 Read 도구로 하나씩 직접 열어서 눈으로 확인하라 (파일을 열지 않고 판단 금지).`,
    ...files.map((f, i) => `  ${i + 1}. ${f.fp}`),
    ...(refFiles.length ? ['', `참고 — 최근 글에 이미 쓰인 사진 ${refFiles.length}장 (후보가 아니다. 7번 기준 비교용으로 이것도 Read 로 열어 볼 것):`, ...refFiles.map(fp => `  - ${fp}`)] : []),
    '',
    criteriaFor(hint),
    wantAlt ? '' : '[커버 칸] 이 사진은 홈페이지 글 상단에 가로로 긴 띠(860×360, 약 2.4:1)로 들어간다 — 사진 높이의 약 60%만 보이고 위아래는 잘린다. 프로그램이 "글 내용과 이어지는 주 피사체"가 띠 한가운데에 오도록 자르므로, 그 피사체의 위치를 fx(가로 0=왼쪽~1=오른쪽)·fy(세로 0=위~1=아래)로 알려 준다(예: 손에 든 휴대폰 화면이 주제면 그 화면의 중심). 주 피사체가 사진 높이의 60% 띠 안에 온전히 들어갈 수 없거나(너무 크거나 세로로 김), 빈 배경·흐린 부분이 절반 이상인 사진은 탈락.',
    '',
    '모든 후보를 본 뒤, 기준을 전부 통과한 사진 중 글에 가장 잘 맞는 1장을 고른다. 통과한 사진이 없으면 pick 을 0 으로.',
    wantAlt
      ? '마지막 줄에 JSON 한 줄만 출력: {"pick": 번호, "reason": "고른 이유 또는 전부 탈락한 이유 (사진에서 본 내용 기준, 한국어 1문장)", "alt": "고른 사진에 실제로 보이는 것을 설명하는 한국어 대체텍스트 (상황+대상+무엇, 25~45자)", "rejected": {"번호": "탈락 이유"}}'
      : '마지막 줄에 JSON 한 줄만 출력: {"pick": 번호, "reason": "고른 이유 또는 전부 탈락한 이유 (사진에서 본 내용 기준, 한국어 1문장)", "fx": 0.5, "fy": 0.5, "rejected": {"번호": "탈락 이유"}}  (fx·fy = 고른 사진에서 주 피사체 중심 위치)',
  ].join('\n');
  const raw = await E.runClaude(prompt, cfg, log);
  const j = jsonIn(raw, '{');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  if (!j) { log && log('  판정 결과를 읽지 못했습니다'); return null; }
  if (j.rejected) for (const [k, v] of Object.entries(j.rejected)) log && log(`  후보 ${k} 탈락: ${v}`);
  const n = Number(j.pick);
  if (!n || !files[n - 1]) { log && log('  통과한 사진 없음: ' + (j.reason || '')); return null; }
  const focus = (isFinite(Number(j.fx)) && isFinite(Number(j.fy)) && j.fx !== null && j.fy !== null) ? { x: Number(j.fx), y: Number(j.fy) } : null;
  return { url: files[n - 1].url, reason: j.reason || '', alt: String(j.alt || '').replace(/["<>]/g, '').trim(), focus };
}

// 커버용 크기로 맞춘 주소 (Pexels 원본은 수 MB라 페이지가 무거워진다)
function coverUrl(u, w = 1290, focus = null) {
  // 커버는 3:2 원본 비율로 넘긴다. 사이트가 칸에 맞춰 가운데를 잘라 보여 준다 —
  // 데스크톱 글 페이지 860×360(위아래가 잘림) · 모바일 높이 220(거의 전체) · 목록 카드 높이 150.
  // 2.4:1 로 미리 잘라 넘기면 모바일에서 좌우까지 잘려 피사체가 빠진다.
  // ★가운데가 아니라 '글 내용과 이어지는 피사체'가 띠 한가운데에 오도록 자른다 (focus = {x, y} 0~1, 사진 안 피사체 위치).
  //   Unsplash: 초점 자르기(focalpoint)로 피사체를 가운데에 둔 3:2 를 만든다. 이미 초점 값이 있는 주소는 그대로 살린다.
  //   Pexels: 초점 자르기를 지원하지 않아, 피사체가 위/아래에 치우쳤으면 그쪽 띠(2.4:1)를 잘라 넘긴다.
  const h = Math.round(w * 2 / 3);
  const base = u.split('?')[0];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, Number(v)));
  if (/images\.unsplash\.com/.test(u)) {
    let f = focus;
    if (!f) {
      const mx = u.match(/[?&]fp-x=([0-9.]+)/), my = u.match(/[?&]fp-y=([0-9.]+)/), mz = u.match(/[?&]fp-z=([0-9.]+)/);
      if (mx && my) f = { x: mx[1], y: my[1], z: mz ? mz[1] : 1.3 };
    }
    if (f && isFinite(f.x) && isFinite(f.y)) return base + `?w=${w}&h=${h}&q=80&auto=format&fit=crop&crop=focalpoint&fp-x=${clamp(f.x, 0, 1).toFixed(2)}&fp-y=${clamp(f.y, 0, 1).toFixed(2)}&fp-z=${clamp(f.z || 1.3, 1, 2).toFixed(2)}`;
    return base + `?w=${w}&h=${h}&q=80&auto=format&fit=crop`;
  }
  if (/images\.pexels\.com/.test(u)) {
    let side = '';
    if (focus && isFinite(focus.y)) side = focus.y < 0.36 ? 'top' : focus.y > 0.64 ? 'bottom' : '';
    else { const m = u.match(/[?&]crop=(top|bottom)\b/); if (m) side = m[1]; }
    if (side) return base + `?auto=compress&cs=tinysrgb&w=${w}&h=${Math.round(w * 360 / 860)}&fit=crop&crop=${side}`;
    return base + `?auto=compress&cs=tinysrgb&w=${w}&h=${h}&fit=crop`;
  }
  return u;
}
// (구) 검수용 가운데 띠 — 지금은 쓰지 않는다. 검수는 전체 사진을 보고 피사체 위치를 받아 자른다.
function coverBandUrl(u, w = 1100) {
  const h = Math.round(w * 360 / 860);
  if (/images\.pexels\.com/.test(u)) return u.split('?')[0] + `?auto=compress&cs=tinysrgb&w=${w}&h=${h}&fit=crop`;
  if (/images\.unsplash\.com/.test(u)) return u.split('?')[0] + `?w=${w}&h=${h}&q=80&auto=format&fit=crop`;
  return u;
}

// ── 세로 사진 대응 (2026-10-13) ─────────────────────────────────────────────
// crop=entropy 는 머리카락·옷 질감처럼 '정보가 많은' 쪽을 남기는 방식이라, 세로 사진에서는 정작 피사체(손·책상·진료 의자)를
// 잘라내는 일이 잦았다(10/12 해외통, 10/13 병원통·스타트업언론통). → 원본의 가로세로를 먼저 읽고, 세로 사진이면
// 더 높은 틀(가로:세로 = 1.25:1)을 쓰고, 피사체가 세로로 어디 있는지(위·가운데·아래) 보고 그 자리에 맞춰 자른다.
function fetchBuf(url, max = 400000) {
  return new Promise(resolve => {
    let done = false; const fin = v => { if (!done) { done = true; resolve(v); } };
    const go = (u, hops) => {
      const req = https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 3) { res.resume(); return go(new URL(res.headers.location, u).href, hops + 1); }
        if (res.statusCode !== 200) { res.resume(); return fin(null); }
        const chunks = []; let size = 0;
        res.on('data', c => { chunks.push(c); size += c.length; if (size >= max) { req.destroy(); fin(Buffer.concat(chunks)); } });
        res.on('end', () => fin(Buffer.concat(chunks)));
        res.on('error', () => fin(chunks.length ? Buffer.concat(chunks) : null));
      });
      req.on('error', () => fin(null)); req.on('timeout', () => { req.destroy(); fin(null); });
    };
    try { go(url, 0); } catch { fin(null); }
  });
}
// JPEG 헤더(SOF)에서 가로·세로를 읽는다 — 그림 라이브러리 없이 Node 만으로
function jpegSize(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xFF) { i++; continue; }
    if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (!len) return null;
    i += 2 + len;
  }
  return null;
}
const ASPECT_CACHE = new Map();   // 원본 주소 → 세로/가로 비율
const BAND_CACHE = new Map();     // 원본 주소 → 피사체 세로 구간 {top,bottom}
function baseOf(u) { return String(u).replace(/&amp;/g, '&').split('?')[0]; }
function tinyUrl(u, w) {
  const b = baseOf(u);
  if (/images\.pexels\.com/.test(b)) return b + `?auto=compress&cs=tinysrgb&w=${w}`;
  if (/images\.unsplash\.com/.test(b)) return b + `?w=${w}&fm=jpg&q=70`;
  return null;
}
async function imageAspect(u) {
  const b = baseOf(u);
  if (ASPECT_CACHE.has(b)) return ASPECT_CACHE.get(b);
  const t = tinyUrl(u, 240);
  if (!t) return null;
  const sz = jpegSize(await fetchBuf(t));
  const a = sz && sz.w ? sz.h / sz.w : null;
  ASPECT_CACHE.set(b, a);
  return a;
}
function isPortrait(a) { return a !== null && a !== undefined && a > 1.15; }
// 세로 사진의 핵심 피사체가 세로 방향 어디에 있는지 Claude 가 사진을 열어 보고 답한다 (맨 위 0 ~ 맨 아래 1)
async function subjectBand(u, ctx) {
  const b = baseOf(u);
  if (BAND_CACHE.has(b)) return BAND_CACHE.get(b);
  if (!ctx || !ctx.E || !ctx.cfg || typeof ctx.E.runClaude !== 'function') return null;
  const dir = path.join(CHECK_DIR, 'p' + Date.now().toString(36));
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, 'full.jpg');
  let band = null;
  try {
    if (await download(tinyUrl(u, 700), fp)) {
      const prompt = [
        `세로로 긴 사진 1장이다. Read 도구로 ${fp} 를 직접 열어 보고 답하라 (열지 않고 판단 금지).`,
        '이 사진을 블로그 본문에 가로로 더 넓은 틀로 잘라 넣을 때, 반드시 남겨야 할 핵심 피사체(사람의 상반신·손·들고 있는 물건·책상 위 자료·장비 등 글 내용을 보여 주는 부분)가',
        '사진의 세로 방향에서 어느 구간에 있는지 알려 달라. 맨 위 = 0, 맨 아래 = 1. 머리 위 빈 벽·천장·바닥만 있는 구간은 제외한다.',
        '마지막 줄에 JSON 한 줄만: {"top": 0.30, "bottom": 0.85, "what": "남겨야 할 것(한국어 짧게)"}',
      ].join('\n');
      const raw = await ctx.E.runClaude(prompt, ctx.cfg, ctx.log);
      const j = jsonIn(raw, '{');
      const t = Number(j && j.top), bt = Number(j && j.bottom);
      if (isFinite(t) && isFinite(bt) && t >= 0 && bt <= 1 && bt > t) band = { top: t, bottom: bt, what: String((j && j.what) || '') };
    }
  } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  BAND_CACHE.set(b, band);
  return band;
}
// 세로 사진용 주소: 틀 = 가로 w × 세로 0.8w, 피사체 구간과 가장 많이 겹치는 위치(위/가운데/아래)로 자른다
function portraitUrl(u, aspect, band, w = 1260) {
  const b = baseOf(u);
  const h = Math.round(w * 0.8);
  const frac = Math.min(1, (h / w) / aspect);   // 틀이 원본 세로의 몇 %를 덮는가
  const wins = { top: [0, frac], center: [(1 - frac) / 2, (1 + frac) / 2], bottom: [1 - frac, 1] };
  let anchor = 'center';
  if (band) {
    let best = -1;
    for (const [k, [a0, a1]] of Object.entries(wins)) {
      const ov = Math.max(0, Math.min(a1, band.bottom) - Math.max(a0, band.top));
      if (ov > best + 1e-6 || (Math.abs(ov - best) <= 1e-6 && k === 'center')) { best = ov; anchor = k; }
    }
  }
  if (/images\.pexels\.com/.test(b)) return b + `?auto=compress&cs=tinysrgb&w=${w}&h=${h}&fit=crop` + (anchor === 'center' ? '' : `&crop=${anchor}`);
  if (/images\.unsplash\.com/.test(b)) {
    const w2 = Math.min(w, 1200), h2 = Math.round(w2 * 0.8);
    const fy = band ? Math.min(1, Math.max(0, (band.top + band.bottom) / 2)) : 0.5;
    return b + `?w=${w2}&h=${h2}&q=80&auto=format&fit=crop&crop=focalpoint&fp-x=0.5&fp-y=${fy.toFixed(2)}&fp-z=1`;
  }
  return u;
}
// 본문 사진 주소 결정: 가로 사진 → 3:2 entropy(기존), 세로 사진 → 피사체 맞춤 틀
async function smartInlineUrl(u, ctx = {}, w = 1260) {
  let a = null;
  try { a = await imageAspect(u); } catch {}
  if (!isPortrait(a)) return inlineUrl(u, w);
  let band = null;
  try { band = await subjectBand(u, ctx); } catch {}
  const out = portraitUrl(u, a, band, w);
  const where = /crop=top/.test(out) ? '위' : /crop=bottom/.test(out) ? '아래' : /fp-y=/.test(out) ? ('fp-y ' + out.match(/fp-y=([\d.]+)/)[1]) : '가운데';
  ctx.log && ctx.log(`  세로 사진(${a.toFixed(2)}:1) 자르기 — 피사체 ${band ? `${band.top}~${band.bottom}${band.what ? ' (' + band.what + ')' : ''}` : '위치 미확인'} → ${where} 틀`);
  return out;
}

// 본문용 크기 (원본은 수 MB라 글이 무거워진다)
function inlineUrl(u, w = 1260) {
  // 본문 사진은 가로 3:2 로 잘라 쓴다 — 세로 사진·여백 큰 사진이 그대로 들어가 빈 공간이 길게 생기는 것을 막는다.
  // crop=entropy: 사진에서 정보가 많은 쪽(피사체)을 남기고 자른다.
  const h = Math.round(w * 2 / 3);
  if (/images\.pexels\.com/.test(u)) return u.split('?')[0] + `?auto=compress&cs=tinysrgb&w=${w}&h=${h}&fit=crop&crop=entropy`;
  if (/images\.unsplash\.com/.test(u)) return u.split('?')[0] + `?w=${Math.min(w, 1200)}&h=${Math.round(Math.min(w, 1200) * 2 / 3)}&q=80&auto=format&fit=crop&crop=entropy`;
  return u;
}

// 원고 속 Pexels·Unsplash 사진 주소를 정리한다: 가로 사진은 3:2 entropy, 세로 사진은 피사체 맞춤 틀 (2026-10-13 세로 대응)
// - 아직 h= 가 없는 주소 → 자르기 적용
// - h= 는 있지만 crop=entropy 인 세로 사진 → 피사체 맞춤으로 다시 자름 (프롬프트가 쓴 기본 주소가 세로 사진을 망치는 경우)
// - 그 밖(이미 사람이 정한 틀)은 그대로 둔다
async function normalizeInline(html, ctx = {}) {
  let n = 0;
  const re = /(<img\b[^>]*?\bsrc=")([^"]+)(")/g;
  const parts = []; let last = 0; let m;
  const src = String(html);
  while ((m = re.exec(src))) {
    parts.push(src.slice(last, m.index));
    const u = m[2].replace(/&amp;/g, '&');
    let rep = m[0];
    if (/^https:\/\/images\.(pexels|unsplash)\.com\//.test(u)) {
      const hasH = /[?&]h=\d+/.test(u);
      const entropy = /crop=entropy/.test(u);
      if (!hasH || entropy) {
        let a = null; try { a = await imageAspect(u); } catch {}
        if (isPortrait(a)) { const nu = await smartInlineUrl(u, ctx); if (nu !== u) { n++; rep = m[1] + nu + m[3]; } }
        else if (!hasH) { n++; rep = m[1] + inlineUrl(u) + m[3]; }
      }
    }
    parts.push(rep);
    last = m.index + m[0].length;
  }
  parts.push(src.slice(last));
  return { html: parts.join(''), n };
}

// 홈페이지 커버 1장
async function pickCover({ E, cfg, log, post, used, refs = [], hint = '', rounds = 2 }) {
  const seen = new Set(used);
  for (let r = 1; r <= rounds; r++) {
    const prompt = [
      `메세지 메디(medi.messeze.com, 병원 전용) 홈페이지 칼럼 "${post.title}" (카테고리 ${post.cat}) 의 커버 사진 후보를 6개 찾아라.`,
      `글 요약: ${String(post.desc || '').slice(0, 160)}`,
      hint ? `- ★원하는 장면: ${hint}` : '',
      '- 사람이 나오는 장면은 "korean", "asian", "seoul" 같은 검색어를 붙여 한국·동아시아 인물 사진을 찾는다.',
      '- Unsplash 또는 Pexels 무료 실사만 (두 곳 모두에서 찾아 섞을 것). 형식: https://images.unsplash.com/photo-XXXXX?w=800&h=450&fit=crop&q=70&auto=format 또는 https://images.pexels.com/photos/ID/pexels-photo-ID.jpeg',
      '- 아래 기준에 맞을 만한 사진을 고른다 (다음 단계에서 실제 사진을 보고 다시 걸러낸다):',
      criteriaFor(hint),
      seen.size ? `- 이미 쓴/탈락한 사진 제외: ${[...seen].slice(-30).join(' , ')}` : '',
      '- 설명 없이 JSON 배열 한 줄만 출력.',
    ].filter(Boolean).join('\n');
    const cands = (jsonIn(await E.runClaude(prompt, cfg, log), '[') || []).filter(u => typeof u === 'string' && /^https:\/\/images\.(unsplash|pexels)\.com\//.test(u));
    log && log(`  커버 후보 ${cands.length}장 (${r}회차) — 내려받아 직접 확인`);
    const pick = await judge({ E, cfg, log, purpose: `글 "${post.title}" 의 커버${hint ? ` (원하는 장면: ${hint})` : ''}`, candidates: cands, used: seen, refs, hint });
    if (pick) return { ...pick, url: coverUrl(pick.url, 1290, pick.focus) };
    cands.forEach(u => seen.add(u));
  }
  return null;
}

// 본문 사진 자리별 1장씩 (블로거·티스토리)
async function pickInline({ E, cfg, log, title, slots, used, hint = '' }) {
  const prompt = [
    `메세지 메디(병원 원장님 대상) 블로그 글 "${title}" 의 사진 ${slots.length}자리를 새 사진으로 바꾸려 한다. 자리마다 그 자리 소제목이 말하는 장면에 맞는 후보를 4개씩 찾아라 (기존 설명은 참고만 — 소제목 내용이 우선).`,
    ...slots.map((s, i) => `  ${i + 1}. 소제목: "${s.section || '(도입부)'}" · 기존 설명: "${s.alt}"`),
    hint ? `- ★원하는 느낌: ${hint}` : '',
    '- Pexels 또는 Unsplash 무료 실사 직접 URL 만 (두 곳 모두에서 찾을 것): https://images.pexels.com/photos/ID/pexels-photo-ID.jpeg 또는 https://images.unsplash.com/photo-XXXXX',
    '- 사람이 나오는 장면은 "korean", "asian", "seoul" 같은 검색어를 붙여 한국·동아시아 인물 사진을 찾는다.',
    '- 아래 기준에 맞을 만한 사진을 고른다 (다음 단계에서 실제 사진을 보고 다시 걸러낸다):',
    criteriaFor(hint),
    `- 이미 쓴 사진 제외: ${[...used].slice(-30).join(' , ')}`,
    '- 설명 없이 JSON 한 줄만: 자리 순서대로 후보 배열의 배열. 예: [["url1a","url1b"],["url2a",...]]',
  ].join('\n');
  const raw = await E.runClaude(prompt, cfg, log);
  const m = String(raw).match(/\[\s*\[[\s\S]*\]\s*\]/);
  let groups = []; try { groups = m ? JSON.parse(m[0]) : []; } catch {}
  const out = [];
  const taken = new Set(used);
  for (let i = 0; i < slots.length; i++) {
    const cands = (groups[i] || []).filter(u => typeof u === 'string' && /^https:\/\/images\.(pexels|unsplash)\.com\//.test(u) && u !== slots[i].src);
    log && log(`  ${i + 1}번 자리 후보 ${cands.length}장 — 내려받아 직접 확인`);
    let pick = cands.length ? await judge({ E, cfg, log, purpose: `글 "${title}" 의 ${i + 1}번 자리(소제목: ${slots[i].section || '도입부'})`, candidates: cands, used: taken, wantAlt: true, hint }) : null;
    if (!pick) {
      // 2회차: 같은 뜻을 전하는 '인물 없는 장면'까지 넓혀서 다시 찾는다 (한국·동아시아 인물 사진이 드문 주제 대비)
      log && log(`  ${i + 1}번 자리 2회차 — 인물 없는 대체 장면까지 넓혀 다시 찾습니다`);
      const p2 = [
        `메세지 메디(병원 원장님 대상) 블로그 글 "${title}" 의 사진 한 자리를 채울 후보를 6개 찾아라. 자리 소제목: "${slots[i].section || '도입부'}" · 기존 설명(참고): "${slots[i].alt}"`,
        '- 1회차에서 서양인 인물 사진만 나와 탈락했다. 한국·동아시아 인물 사진을 "korean", "asian" 검색어로 다시 찾되, 없으면 같은 뜻을 전하는 인물 없는 장면(공간·기기 화면·사물·손 클로즈업)으로 대체해도 된다.',
        hint ? `- ★원하는 느낌: ${hint}` : '',
        '- Pexels 또는 Unsplash 무료 실사 직접 URL 만.',
        criteriaFor(hint),
        `- 이미 쓴/탈락한 사진 제외: ${[...taken, ...cands].slice(-40).join(' , ')}`,
        '- 설명 없이 JSON 배열 한 줄만 출력.',
      ].filter(Boolean).join('\n');
      const c2 = (jsonIn(await E.runClaude(p2, cfg, log), '[') || []).filter(u => typeof u === 'string' && /^https:\/\/images\.(pexels|unsplash)\.com\//.test(u) && u !== slots[i].src);
      cands.forEach(u => taken.add(u));
      pick = c2.length ? await judge({ E, cfg, log, purpose: `글 "${title}" 의 ${i + 1}번 자리(소제목: ${slots[i].section || '도입부'} — 인물 없는 대체 장면 허용)`, candidates: c2, used: taken, wantAlt: true, hint }) : null;
    }
    if (pick) taken.add(pick.url);
    out.push(pick ? { ...pick, url: await smartInlineUrl(pick.url, { E, cfg, log }) } : null);
  }
  return out;
}

// 이미 정해진 사진 1장을 기준으로 검수 → { ok, reason }
async function review({ E, cfg, log, url, purpose, refs = [] }) {
  const r = await judge({ E, cfg, log, purpose, candidates: [url], used: new Set(), refs: refs.filter(u => u !== url) });
  return r ? { ok: true, reason: r.reason, focus: r.focus || null } : { ok: false };
}

module.exports = { CRITERIA, pickCover, pickInline, review, download, inlineUrl, normalizeInline, coverUrl, coverBandUrl, smartInlineUrl, imageAspect, isPortrait, portraitUrl };
