// selftest.js — 설치 점검. 실행: node selftest.js (또는 RUN_selftest.bat)
// 새 PC 에 설치한 뒤 무엇이 빠졌는지 한 번에 보여 준다. 아무것도 바꾸지 않는다(읽기만).
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const OK = '[ OK ]', BAD = '[없음]', WARN = '[확인]';
let bad = 0;
const say = (tag, what, how) => { if (tag === BAD) bad++; console.log(`${tag} ${what}${how ? '\n        → ' + how : ''}`); };
const has = (cmd) => { try { execSync(cmd, { stdio: 'ignore', windowsHide: true }); return true; } catch { return false; } };

console.log('──────────────────────────────────────────────');
console.log('  메세지 메디 자동화 점검  ' + new Date().toLocaleString('ko-KR'));
console.log('──────────────────────────────────────────────');

console.log('\n■ 필수 프로그램');
say(OK, 'Node.js ' + process.version);
for (const m of ['googleapis', 'playwright-core']) {
  try { require.resolve(m); say(OK, m + ' 설치됨'); } catch { say(BAD, m + ' 없음', '프로그램 폴더에서 npm install 을 실행하세요 (INSTALL.bat).'); }
}
const chrome = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')].some(p => fs.existsSync(p));
say(chrome ? OK : BAD, 'Google Chrome' + (chrome ? '' : ' 없음'), chrome ? '' : '티스토리·홈페이지 발행은 Chrome 창으로 합니다. Chrome 을 설치하세요.');
const ff = has('ffmpeg -version');
say(ff ? OK : WARN, 'ffmpeg' + (ff ? '' : ' 없음'), ff ? '' : '티스토리에 사진을 올릴 때 필요합니다(없으면 사진이 외부 링크로 남습니다). winget install ffmpeg');
let E; try { E = require('./engine'); } catch (e) { say(BAD, 'engine.js 읽기 실패', e.message); }
if (E) say(E.CLAUDE ? OK : BAD, 'Claude Code' + (E.CLAUDE ? ' — ' + E.CLAUDE : ' 없음'), E.CLAUDE ? '' : 'Claude 데스크톱 앱 또는 Claude Code CLI 를 설치하세요.');

console.log('\n■ 설정·프롬프트');
let cfg;
try { cfg = require('./config').load(); say(OK, 'writer_config.json 읽기 성공' + (fs.existsSync(require('./config').LOCAL_FILE) ? ' (+ writer_config.local.json)' : '')); }
catch (e) { say(BAD, 'writer_config.json 읽기 실패', e.message); }
if (cfg) {
  for (const [name, p] of [['블로거 프롬프트', cfg.enginePrompt], ['티스토리 프롬프트', cfg.tistory.enginePrompt], ['홈페이지 칼럼 프롬프트', cfg.medi.enginePrompt]]) say(p && fs.existsSync(p) ? OK : BAD, name + (p && fs.existsSync(p) ? '' : ' 없음: ' + p));
  try { const n = require('./medi-lib').loadBank().length; say(n ? OK : BAD, `질문표 ${n}문항`); } catch (e) { say(BAD, '질문표 읽기 실패', e.message); }
  const noId = cfg.blogs.filter(b => !b.blogId).map(b => b.name);
  say(noId.length ? BAD : OK, noId.length ? 'blogId 가 비어 있는 블로거 블로그: ' + noId.join(', ') : `블로거 블로그 ${cfg.blogs.length}개 · 티스토리 ${cfg.tistory.blogs.length}개`);
}

console.log('\n■ 연동 (PC 마다 1회)');
const cs = fs.readdirSync(__dirname).some(n => /^client_secret.*\.json$/i.test(n) || n === 'credentials.json');
say(cs ? OK : BAD, cs ? '블로거 OAuth 클라이언트 파일 있음' : 'client_secret*.json 없음', cs ? '' : '관리자에게 받은 client_secret 파일을 프로그램 폴더에 넣으세요 (README "블로거 연동").');
const tok = fs.existsSync(path.join(__dirname, 'token.json'));
say(tok ? OK : BAD, tok ? '블로거 구글 인증 완료(token.json)' : '블로거 구글 인증 안 됨', tok ? '' : '대시보드에서 [발행 API 연동(구글 인증)] 을 누르세요.');
if (cfg) {
  const ts = fs.existsSync(path.join(cfg.tistory.sessionDir, 'auth.json'));
  say(ts ? OK : BAD, ts ? '티스토리 로그인 세션 있음' : '티스토리 로그인 안 됨', ts ? '' : '대시보드에서 [티스토리 로그인(카카오)] 을 누르세요.');
  const ms = fs.existsSync(path.join(cfg.medi.sessionDir, 'auth_medi.json'));
  say(ms ? OK : BAD, ms ? '메디 관리자 로그인 세션 있음' : '메디 관리자 로그인 안 됨', ms ? '' : '대시보드 홈페이지 칼럼 패널에서 [메디 관리자 로그인] 을 누르세요.');
}
try {
  const acc = require('./accounts').list();
  const n = (acc.accounts || acc || []).length;
  say(OK, `Claude 계정 저장소: ${n}개 등록 — 로그인 상태는 대시보드 "Claude 계정 연동" 에서 확인`);
} catch (e) { say(WARN, 'Claude 계정 목록을 읽지 못함', e.message); }

console.log('\n■ 업데이트');
(async () => {
  try {
    const U = require('./updater');
    const r = await U.check();
    if (r.ok) say(OK, `v${r.version} · 방식 ${r.mode} · ${r.behind ? '새 버전 v' + r.latest + ' 있음 — 대시보드 [업데이트 확인] 또는 RUN_update.bat' : '최신'}`);
    else say(WARN, `업데이트 확인 실패 (v${r.version})`, r.msg);
  } catch (e) { say(WARN, '업데이트 확인 실패', e.message); }
  console.log('\n──────────────────────────────────────────────');
  console.log(bad ? `  ${bad}개 항목을 채워야 합니다 (위 [없음] 줄).` : '  모두 준비됐습니다.');
  console.log('──────────────────────────────────────────────');
  process.exit(0);
})();
