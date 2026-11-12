# messeze-medi-auto

메세지AI 메디(medi.messeze.com) 콘텐츠 자동화 대시보드.
메세지 본 프로그램(messeze-auto)에서 **메디 부분만 떼어** 따로 만든 프로그램입니다.

| 채널 | 대상 | 발행 방식 |
|---|---|---|
| 블로거 4개 | medi-messeze · medi-dental · medi-beauty-clinic · medi-animal (blogspot) | Blogger API |
| 티스토리 4개 | medi-messeze · medi-dental · medi-beauty · medi-animal (tistory) | Chrome 창 자동 입력 |
| 홈페이지 칼럼 | medi.messeze.com/blog | 관리자(/admin) 화면 자동 입력 |

대시보드 주소: **http://127.0.0.1:5015**
생성만으로는 절대 발행되지 않습니다. 미리보기로 확인한 뒤 [발행]을 누른 글만 올라갑니다.

---

## 1. 새 PC 에 설치

준비물: Windows, [Node.js LTS](https://nodejs.org), Google Chrome, Claude 데스크톱 앱(또는 Claude Code CLI). 티스토리에 사진을 올리려면 ffmpeg (`winget install ffmpeg`).

**방법 A — git 으로 받기 (권장: 업데이트가 가장 간단)**

```
git clone https://github.com/<소유자>/messeze-medi-auto.git
```

GitHub Desktop 을 쓰면 File → Clone repository 로 받아도 됩니다.

**방법 B — ZIP 으로 받기**

GitHub 저장소 화면 → Code → Download ZIP → 원하는 폴더에 압축 풀기.
(비공개 저장소라면 업데이트를 위해 `update_token.txt` 에 읽기 전용 GitHub 토큰 한 줄을 넣어야 합니다.)

받은 뒤:

1. `INSTALL.bat` 더블클릭 → 패키지 설치 + 점검표 출력
2. `RUN_dashboard.bat` 더블클릭 → 대시보드가 켜지고 브라우저가 열립니다

## 2. PC 마다 한 번 하는 연동

로그인 정보·토큰은 **저장소에 올라가지 않습니다.** 설치한 PC 마다 한 번씩 연동합니다.

| 무엇 | 어떻게 |
|---|---|
| Claude 계정 | 대시보드 아래 **Claude 계정 연동** → 계정 추가 → 로그인. 여러 개 넣으면 한도에 걸릴 때 자동으로 다음 계정을 씁니다. |
| 블로거 | ① 관리자에게 받은 `client_secret*.json` 을 프로그램 폴더에 넣기 ② 대시보드 [발행 API 연동(구글 인증)] → 메디 블로그 4개를 가진 구글 계정으로 동의 |
| 티스토리 | [티스토리 로그인(카카오)] → 열린 Chrome 창에서 직접 로그인 → [카테고리 추출] |
| 홈페이지 칼럼 | 홈페이지 칼럼 패널 [메디 관리자 로그인] → 열린 Chrome 창에서 직접 로그인 (글쓰기 화면 구조를 읽어 둡니다) |

`RUN_selftest.bat` 을 실행하면 무엇이 빠졌는지 한 번에 보입니다.

## 3. 업데이트 (원격)

저장소에 새 버전이 올라가면 설치된 PC 들이 받아 갑니다.

- **자동**: `RUN_dashboard.bat` 으로 켤 때마다 새 버전을 확인하고 받습니다.
- **수동**: 대시보드 위쪽 **[업데이트 확인]** → 새 버전이 있으면 받고 대시보드가 다시 켜집니다. 또는 `RUN_update.bat`.

업데이트로 바뀌는 것은 프로그램 파일(코드·프롬프트·기본 설정·질문표)뿐입니다.
원고(`posts/`), 큐(`queue*.json`), 보관본(`output/`), 로그인 세션, 토큰, `writer_config.local.json` 은 그대로 남습니다.

## 4. 수정해서 배포하기 (관리자 PC)

1. 코드·프롬프트를 고친다
2. `package.json` 의 `version` 을 올린다 (예: 0.1.0 → 0.1.1) — ZIP 방식 PC 는 이 숫자로 새 버전을 판단합니다
3. commit → push (GitHub Desktop 또는 `git push`)

## 5. 설정

- `writer_config.json` — 저장소 기본값(블로그 목록, 프롬프트 위치, 글 길이 기준). **고치면 모든 PC 에 배포됩니다.**
- `writer_config.local.json` — 이 PC 에서만 쓸 값. 같은 키로 적으면 기본값을 덮어씁니다. 예:

```json
{ "port": 5015, "model": "opus", "autoDaily": true, "autoTime": "07:30", "tistory": { "autoDaily": true } }
```

블로그를 바꾸려면 `blogs` / `tistory.blogs` 를 고칩니다. 블로거 `blogId` 는 구글 인증 후 `node _list_blogs.js` 로 확인합니다.

## 6. 질문은 어디서 오나

`prompts/메세지_메디_질문표_v2.csv` (구글 시트: 지역 × 진료과 × 진료항목 × 고민 유형 500문항).
생성할 때마다 구글 시트에서 새로 받아 `data/질문표_동기화.csv` 에 둡니다(받지 못하면 저장소에 든 파일을 씁니다).

질문은 **프로그램이 블로그별로 골라** 프롬프트에 넣어 줍니다.

| 블로그 | 쓰는 질문 |
|---|---|
| 1 메디 종합 | 치과·피부과·성형외과를 뺀 나머지 진료과 |
| 2 치과 | 진료과 = 치과 |
| 3 피부·성형 | 진료과 = 피부과, 성형외과 |
| 4 동물병원 | 진료과 = 동물병원. **질문표에 동물병원 문항이 없는 동안은** 다른 진료과 질문의 진료과·진료항목만 동물병원 것으로 바꿔 씁니다. 시트에 진료과 "동물병원" 문항을 20개 이상 넣으면 그 문항만 씁니다. |
| 홈페이지 칼럼 | 전체 (고민 유형·지역·진료과가 연달아 겹치지 않게) |

- 같은 채널에서 한 번 쓴 질문은 다시 쓰지 않습니다(다 쓰면 가장 오래전에 쓴 것부터 다른 각도로).
- 같은 날 블로거·티스토리·홈페이지 칼럼이 같은 질문을 쓰지 않습니다.

## 7. 파일 구성

```
writer.js            대시보드 서버 (포트 5015)
writer-ui.html       화면
engine.js            생성 엔진 (claude 실행, 검증, 보관)
config.js            설정 읽기 (writer_config.json + writer_config.local.json)
updater.js           원격 업데이트
medi-lib.js          질문표·질문 배정·메디 사이트 도우미
medi-gen.js          홈페이지 칼럼 생성     medi-validate.js  형식 검증
medi-poster.js       홈페이지 칼럼 발행     medi-login.js     관리자 로그인
medi-export.js       미리보기·보관본
poster.js / blogauth.js        블로거 발행·인증
tistory-*.js                   티스토리 로그인·카테고리·발행
image-pick.js        사진 고르기(Claude 가 사진을 열어 보고 판단)
accounts.js          Claude 다계정
prompts/             프롬프트 3종 + 질문표
```

이 PC 에만 있고 저장소에 올라가지 않는 것: `posts/` `output/` `data/` `queue*.json` `*_topics_log.txt` `token.json` `client_secret*.json` `tistory-session/` `medi-session/` `claude-accounts/` `writer_config.local.json` `update_token.txt`

## 8. 문제가 생기면

- 대시보드가 안 켜진다 → 5015 포트를 다른 프로그램이 쓰고 있는지 확인(`netstat -ano | findstr :5015`), 또는 `writer_config.local.json` 에 `{ "port": 5016 }`
- "claude 없음" → Claude 데스크톱 앱 설치 후 대시보드를 다시 켠다
- 티스토리 발행 중 캡차가 뜬다 → 열린 Chrome 창에서 직접 풀면 이어서 진행됩니다(자동으로 풀지 않습니다)
- 업데이트가 실패한다 → `RUN_update.bat` 의 메시지를 확인. git 방식에서 이 PC 가 프로그램 파일을 고쳤다면 그 수정은 `git stash` 로 따로 보관됩니다.
