# messeze-medi-auto 설치 안내서 (Claude 가 읽고 따라 하는 문서)

> **Claude 에게:** 사용자가 이 문서를 전달했습니다. 아래 순서대로 사용자의 Windows PC 에 **messeze-medi-auto** 프로그램을 설치하고, 사람만 할 수 있는 단계(로그인)는 사용자가 직접 하도록 안내하세요.
> 한 단계씩 진행하고, 단계가 끝날 때마다 결과를 짧게 알려 주세요. 사용자가 쓰는 언어로 답하세요.

## 이 프로그램은

메세지AI 메디(medi.messeze.com)용 글 자동 작성 대시보드입니다. 티스토리 블로그 4개, 블로거 블로그 4개, 홈페이지 칼럼을 다룹니다. 사용자 PC 에서 Node.js 로 실행되며 주소는 `http://127.0.0.1:5015` 입니다.
소스는 공개 저장소에 있습니다: https://github.com/anhptt22/messeze-medi-auto (내려받는 데 GitHub 계정이 필요 없습니다.)

## Claude 가 반드시 지킬 규칙

1. **비밀번호·인증 코드를 대신 입력하거나 캡차를 대신 풀지 않습니다.** 5장의 로그인은 모두 사용자가 브라우저 창에서 직접 합니다. Claude 는 어느 버튼을 누르는지만 안내합니다.
2. **프로그램 파일을 고치지 않습니다** (`*.js`, `writer-ui.html`, `prompts/`, `writer_config.json`). 프로그램은 원격으로 업데이트되므로, 이 PC 에서 고친 파일은 업데이트 때 문제를 일으킵니다. 이 PC 만의 설정이 필요하면 `writer_config.local.json` 만 만들거나 고칩니다(7장).
3. **사용자를 대신해 발행(발행 버튼)을 누르지 않고**, 발행 API 를 직접 호출하지 않습니다. Claude 의 일은 설치와 안내까지입니다.
4. **비밀 파일을 PC 밖으로 내보내지 않습니다**: `client_secret*.json`, `token.json`, `tistory-session`·`medi-session`·`claude-accounts` 폴더. 내용을 대화창에 출력하지도 않습니다.
5. **Claude 의 작업 세션 안에서 `node writer.js` 를 실행하지 않습니다.** 프로그램은 사용자가 `RUN_dashboard.bat` 으로 켜야 합니다(4장). 그렇지 않으면 세션이 끝날 때 프로그램이 꺼지거나, 5015 포트를 붙잡은 프로세스가 남습니다.
6. 어떤 단계가 실패하면 멈추고, 오류 메시지를 그대로 알린 뒤 8장을 먼저 확인합니다.

---

## 1장 — PC 확인

PowerShell 에서 실행하고 결과를 알려 주세요.

```powershell
node -v
```

```powershell
Test-Path "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

- **Node.js**: 18 버전 이상이 필요합니다. 명령을 찾을 수 없다고 나오면 사용자에게 https://nodejs.org 에서 LTS 버전을 설치하도록 안내하고, 설치 후 **PowerShell 창을 새로 연 뒤** 다시 확인합니다. 설치 파일을 대신 내려받아 실행하지 않습니다.
- **Google Chrome**: 필수입니다(티스토리·메디 관리자 발행은 Chrome 창으로 합니다). `False` 이면 `C:\Program Files (x86)\Google\Chrome\Application\chrome.exe` 도 확인하고, 없으면 사용자에게 Chrome 설치를 안내합니다.
- **Claude**: 프로그램은 Claude Code 로 글을 씁니다. 사용자가 Claude 데스크톱 앱이나 Claude Code 로 지금 대화하고 있다면 이미 갖춰진 것으로 봅니다.
- **ffmpeg** (선택): 티스토리에 사진을 올릴 때 필요합니다. `ffmpeg -version` 으로 확인합니다. 없으면 사용자에게 `winget install ffmpeg` 실행을 제안합니다. 없어도 프로그램은 동작하며, 티스토리 글의 사진이 외부 링크로 남을 뿐입니다.

## 2장 — 프로그램 내려받기

기본 설치 폴더는 **`C:\messeze-medi-auto`** 입니다. 이 폴더가 이미 있고 안에 `writer.js` 가 있으면 이미 설치된 것입니다: **덮어쓰지 말고** 바로 3장으로 갑니다.

```powershell
$zip = "$env:TEMP\messeze-medi-auto.zip"
$tmp = "$env:TEMP\messeze-medi-auto-unzip"
Invoke-WebRequest -Uri "https://github.com/anhptt22/messeze-medi-auto/archive/refs/heads/main.zip" -OutFile $zip
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
Move-Item -LiteralPath "$tmp\messeze-medi-auto-main" -Destination "C:\messeze-medi-auto"
Test-Path "C:\messeze-medi-auto\writer.js"
```

마지막 줄이 `True` 여야 합니다.

참고: 사용자가 다른 위치를 원하면 그래도 됩니다. 다만 경로에 `[ ]` 문자가 있거나 동기화 폴더(OneDrive, Google Drive) 안인 곳은 피합니다.

## 3장 — 패키지 설치와 점검

```powershell
Set-Location C:\messeze-medi-auto
npm install --no-audit --no-fund
```

```powershell
Set-Location C:\messeze-medi-auto
node selftest.js
```

`selftest.js` 결과 읽는 법:

- **필수 프로그램**, **설정·프롬프트** 항목은 모두 `[ OK ]` 여야 합니다(ffmpeg 만 `[확인]` 허용).
- **연동** 항목이 지금 `[없음]` 인 것은 정상입니다. 5장의 로그인 단계입니다.
- **업데이트** 항목은 `방식 zip` 과 `최신` 이 나와야 합니다.

## 4장 — 블로거 파일 넣기와 프로그램 켜기

**4.1. 관리자가 준 파일.** 사용자에게 관리자로부터 `client_secret.json` 파일(경우에 따라 `token.json` 도 함께)을 받았는지 물어봅니다. 이 파일들은 GitHub 에 없습니다.

- 받았으면: `C:\messeze-medi-auto` 에 넣도록 안내합니다(사용자가 경로를 알려 주면 Claude 가 복사해도 됩니다). 파일 이름은 그대로 둡니다.
- 아직 없으면: 설치는 계속할 수 있습니다. 티스토리와 홈페이지 칼럼은 정상적으로 쓸 수 있고, 블로거는 파일을 받을 때까지 자동 발행만 안 됩니다(글 작성과 수동 발행은 가능).

**4.2. 프로그램 켜기.** 사용자에게 **`C:\messeze-medi-auto\RUN_dashboard.bat` 을 더블클릭**하도록 안내합니다. 검은 창이 뜨고 브라우저에 `http://127.0.0.1:5015` 가 열립니다.

- 검은 창은 열어 두어야 합니다. 닫으면 프로그램이 꺼집니다.
- 켤 때마다 자동으로 새 버전을 확인하고 받습니다.
- `RUN_dashboard.bat` 의 바로가기를 바탕화면에 만들어 두도록 제안합니다.

사용자가 켠 뒤, 다음으로 실행 여부를 확인할 수 있습니다.

```powershell
(Invoke-RestMethod http://127.0.0.1:5015/api/state) | Select-Object version, claude, apiReady, apiHasSecret
```

`claude` 가 `True` 여야 합니다. `False` 이면 8장을 봅니다.

## 5장 — 로그인 (사용자가 직접, PC 마다 한 번)

대시보드에서 순서대로 하도록 안내합니다. 버튼 이름은 화면에 보이는 그대로입니다.

| # | 무엇 | 대시보드 버튼 | 사용자가 할 일 |
|---|---|---|---|
| 1 | Claude 계정 | 화면 아래 **Claude 계정 연동** 카드 → 계정 이름을 아무거나 입력 → **[+ 계정 추가(로그인)]** | 브라우저에서 Claude 계정으로 로그인하고, 받은 코드를 대시보드에 붙여넣습니다. 이 단계가 없으면 글을 쓸 수 없습니다. |
| 2 | 블로거 | 블로거 열의 **[발행 API 연동(구글 인증)]** | **메디 블로그 4개를 가진 구글 계정**으로 로그인하고 동의합니다. 관리자가 `token.json` 을 함께 보냈다면 이 단계는 건너뜁니다. |
| 3 | 티스토리 | 티스토리 열의 **[티스토리 로그인(카카오)]** → 이어서 **[카테고리 추출]** | 열린 Chrome 창에서 카카오 계정으로 로그인합니다. 도중에 창을 닫지 않습니다(끝나면 저절로 닫힙니다). |
| 4 | 홈페이지 칼럼 | 홈페이지 칼럼 열의 **[메디 관리자 로그인]** | 열린 Chrome 창에서 medi.messeze.com 관리자 화면에 로그인합니다. |

로그인 정보는 관리자가 사용자에게 전달합니다. Claude 는 이 비밀번호들을 묻거나 저장하거나 입력하지 않습니다.

완료되면 화면 위쪽 칩이 `claude OK`, `블로거 API OK`, `티스토리 세션 OK` 로 바뀝니다. `node selftest.js` 를 다시 실행해 **연동** 항목이 `[ OK ]` 인지 확인할 수 있습니다.

## 6장 — 매일 쓰는 방법 (사용자에게 짧게 설명)

1. `RUN_dashboard.bat` 을 켭니다.
2. 쓰려는 블로그의 **[1편 쓰기]** 를 누르거나, **[티스토리 4건 생성]** / **[블로거 4건 생성]** 으로 4개 블로그 글을 한 번에 씁니다. 글 1편에 6~15분쯤 걸립니다. 홈페이지 칼럼은 **[메디 칼럼 생성 (1편)]**.
3. **[미리보기]** 로 글을 확인합니다. 필요하면 **[제목 다시]**(제목 새로), **[이미지 교체]**(사진 바꾸기), **[다시 쓰기]**(새로 쓰기).
4. **[발행]** 을 누른 글만 올라갑니다. 생성만으로는 블로그에 올라가지 않습니다.
5. 블로거를 손으로 올릴 때: 글 아래 **수동 발행 정보** 를 펼쳐 **[본문 HTML 복사]** → Blogger 글쓰기 화면을 **HTML 보기** 로 바꿔 붙여넣기 → 제목·퍼머링크·검색 설명·라벨은 각 **[복사]** 버튼으로 → 올린 뒤 **[수동 발행 완료]**. (**[VS Code 로 열기]** 로 원고 파일을 직접 열 수도 있습니다.)
6. 티스토리 발행 중 캡차가 뜨면 사용자가 Chrome 창에서 직접 풉니다. 프로그램이 기다렸다가 이어서 발행합니다.

## 7장 — 업데이트와 이 PC 만의 설정

- **업데이트**: `RUN_dashboard.bat` 을 켤 때마다 자동입니다. 실행 중에 받으려면 대시보드 위쪽 **[업데이트 확인]** 을 누릅니다. 프로그램이 새 버전을 받고 스스로 다시 켜집니다. 작성한 글, 큐, 로그인 정보는 그대로 유지됩니다.
- **이 PC 만의 설정**: `C:\messeze-medi-auto\writer_config.local.json` 파일을 만들고 바꿀 키만 적습니다. 예) 포트를 바꾸고 매일 아침 7:30 자동 작성 켜기:

```json
{ "port": 5016, "autoDaily": true, "autoTime": "07:30", "tistory": { "autoDaily": true } }
```

이 파일을 고친 뒤에는 검은 창을 닫고 `RUN_dashboard.bat` 을 다시 켜야 합니다. `writer_config.json` 은 고치지 않습니다.

## 8장 — 자주 생기는 문제

| 증상 | 해결 |
|---|---|
| `node` 명령을 찾을 수 없음 | Node.js 가 설치되지 않았거나, 설치 후 PowerShell 창을 새로 열지 않았습니다. |
| `npm install` 네트워크 오류 | 명령을 다시 실행합니다. 회사 프록시를 쓰는 PC 라면 사용자에게 알립니다. |
| 검은 창에 `Cannot start ... port 5015 already in use` | 다른 프로그램이 5015 포트를 쓰고 있습니다. `netstat -ano \| findstr :5015` 로 확인합니다. 같은 프로그램을 두 번 켠 것이면 하나를 닫고, 다른 프로그램이면 `writer_config.local.json` 으로 포트를 바꿉니다(7장). |
| 대시보드에 `claude 없음` | 프로그램이 Claude Code 를 찾지 못했습니다. 사용자에게 Claude 데스크톱 앱 설치·업데이트를 안내한 뒤, 검은 창을 닫고 `RUN_dashboard.bat` 을 다시 켭니다. |
| 글 생성 시 `Not logged in` 또는 `모든 계정 소진/미로그인` | 대시보드에서 Claude 계정 로그인을 하지 않았거나(5장 1번), 계정 사용 한도가 찼습니다. Claude 계정 연동 카드에서 다른 계정을 추가합니다. |
| 블로거에 `client_secret*.json 없음` | 관리자가 준 파일을 프로그램 폴더에 넣지 않았습니다(4.1). |
| 구글 인증에서 앱이 차단됨·확인되지 않은 앱이라고 나옴 | 멈추고, 화면 캡처와 함께 관리자에게 알립니다. 우회 방법을 찾지 않습니다. |
| `[업데이트 확인]` 오류 | `RUN_update.bat` 을 실행해 전체 메시지를 확인합니다. 대부분 인터넷 연결 문제입니다. |

## 설치가 끝나면 사용자에게 알릴 것

몇 줄로 요약합니다: 프로그램이 설치된 위치, 켜는 파일, 로그인 단계 중 끝난 것과 남은 것(특히 `client_secret.json` 을 아직 받지 못했다면 그 사실).
