# Hướng dẫn cài đặt messeze-medi-auto (dành cho Claude đọc và làm theo)

> **Gửi Claude:** người dùng vừa đưa cho bạn file này. Nhiệm vụ của bạn là cài chương trình **messeze-medi-auto** lên máy Windows của họ theo đúng các bước dưới đây, rồi hướng dẫn họ làm những bước chỉ con người mới làm được (đăng nhập).
> Làm lần lượt từng bước, sau mỗi bước báo ngắn gọn kết quả. Trả lời người dùng bằng ngôn ngữ họ đang dùng.

## Chương trình này là gì

Dashboard tự động viết bài cho 메세지AI 메디 (medi.messeze.com): 4 blog Tistory, 4 blog Blogger và cột bài trên homepage. Chạy bằng Node.js trên máy người dùng, mở ở `http://127.0.0.1:5015`.
Mã nguồn công khai: https://github.com/anhptt22/messeze-medi-auto (không cần tài khoản GitHub để tải).

## Quy tắc bắt buộc với Claude

1. **Không nhập mật khẩu, mã xác thực hay giải captcha thay người dùng.** Mọi bước đăng nhập ở Phần 5 do người dùng tự làm trong cửa sổ trình duyệt; bạn chỉ hướng dẫn họ bấm nút nào.
2. **Không sửa các file của chương trình** (`*.js`, `writer-ui.html`, `prompts/`, `writer_config.json`). Chương trình được cập nhật từ xa; file bị sửa tại máy sẽ gây lỗi khi update. Nếu cần đổi cài đặt riêng cho máy này, chỉ tạo/sửa `writer_config.local.json` (xem Phần 7).
3. **Không bấm đăng bài (발행) thay người dùng** và không gọi các API đăng bài. Việc của bạn dừng ở cài đặt và hướng dẫn.
4. **Không đưa các file bí mật ra ngoài máy**: `client_secret*.json`, `token.json`, thư mục `tistory-session`, `medi-session`, `claude-accounts`. Không in nội dung của chúng ra màn hình chat.
5. **Không chạy `node writer.js` trong phiên làm việc của bạn.** Chương trình phải do người dùng mở bằng `RUN_dashboard.bat` (xem Phần 4), nếu không nó sẽ tắt khi phiên của bạn kết thúc hoặc để lại tiến trình chiếm cổng 5015.
6. Nếu một bước thất bại, dừng lại, báo nguyên văn thông báo lỗi và xem Phần 8 trước khi thử cách khác.

---

## Phần 1 — Kiểm tra máy

Chạy trong PowerShell và báo kết quả:

```powershell
node -v
```

```powershell
Test-Path "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

- **Node.js**: cần bản 18 trở lên. Nếu lệnh báo không tìm thấy, bảo người dùng tải bản LTS ở https://nodejs.org , cài xong thì **mở lại cửa sổ PowerShell** rồi kiểm tra lại. Không tự tải và chạy file cài đặt thay họ.
- **Google Chrome**: bắt buộc (Tistory và admin medi đăng bằng cửa sổ Chrome). Nếu `False`, kiểm tra thêm `C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`; không có thì bảo người dùng cài Chrome.
- **Claude**: chương trình dùng Claude Code để viết bài. Người dùng đang nói chuyện với bạn qua ứng dụng Claude desktop hoặc Claude Code thì coi như đã có.
- **ffmpeg** (không bắt buộc): cần để tải ảnh lên Tistory. Kiểm tra bằng `ffmpeg -version`. Nếu chưa có, đề nghị người dùng chạy `winget install ffmpeg`; thiếu thì chương trình vẫn chạy, chỉ là ảnh trong bài Tistory giữ link ngoài.

## Phần 2 — Tải chương trình

Thư mục cài đặt mặc định: **`C:\messeze-medi-auto`**. Nếu thư mục này đã tồn tại và có file `writer.js` bên trong, chương trình đã được cài: **không tải đè**, chuyển thẳng sang Phần 3.

```powershell
$zip = "$env:TEMP\messeze-medi-auto.zip"
$tmp = "$env:TEMP\messeze-medi-auto-unzip"
Invoke-WebRequest -Uri "https://github.com/anhptt22/messeze-medi-auto/archive/refs/heads/main.zip" -OutFile $zip
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
Move-Item -LiteralPath "$tmp\messeze-medi-auto-main" -Destination "C:\messeze-medi-auto"
Test-Path "C:\messeze-medi-auto\writer.js"
```

Dòng cuối phải in `True`.

Lưu ý: nếu người dùng muốn cài ở chỗ khác thì được, nhưng tránh đường dẫn có ký tự `[ ]` hoặc nằm trong thư mục đồng bộ (OneDrive, Google Drive).

## Phần 3 — Cài package và tự kiểm tra

```powershell
Set-Location C:\messeze-medi-auto
npm install --no-audit --no-fund
```

```powershell
Set-Location C:\messeze-medi-auto
node selftest.js
```

Đọc bảng kết quả của `selftest.js`:

- Mục **필수 프로그램** và **설정·프롬프트** phải toàn `[ OK ]` (riêng ffmpeg được phép `[확인]`).
- Mục **연동** lúc này báo `[없음]` là bình thường: đó là các bước đăng nhập ở Phần 5.
- Mục **업데이트** phải báo `방식 zip` và `최신`.

## Phần 4 — Chép file Blogger và mở chương trình

**4.1. File từ quản lý.** Hỏi người dùng đã nhận được file `client_secret.json` (có thể kèm `token.json`) từ quản lý chưa. Hai file này không có trên GitHub.

- Có rồi: bảo họ chép vào `C:\messeze-medi-auto` (hoặc họ cho bạn đường dẫn để bạn chép). Giữ nguyên tên file.
- Chưa có: vẫn cài tiếp được. Tistory và cột homepage dùng bình thường; riêng Blogger chưa đăng được cho tới khi có file.

**4.2. Mở chương trình.** Bảo người dùng **bấm đúp file `C:\messeze-medi-auto\RUN_dashboard.bat`**. Một cửa sổ đen hiện ra và trình duyệt tự mở `http://127.0.0.1:5015`.

- Cửa sổ đen phải để mở; đóng nó là chương trình tắt.
- Mỗi lần mở, file này tự kiểm tra và tải bản cập nhật.
- Gợi ý người dùng tạo shortcut của `RUN_dashboard.bat` ra Desktop.

Sau khi họ mở, bạn có thể xác nhận chương trình đang chạy:

```powershell
(Invoke-RestMethod http://127.0.0.1:5015/api/state) | Select-Object version, claude, apiReady, apiHasSecret
```

`claude` phải là `True`. Nếu `False`: xem Phần 8.

## Phần 5 — Đăng nhập (người dùng tự làm, mỗi máy một lần)

Hướng dẫn người dùng làm lần lượt trên dashboard. Tên nút ghi nguyên văn tiếng Hàn như trên màn hình.

| # | Việc | Nút trên dashboard | Người dùng làm gì |
|---|---|---|---|
| 1 | Tài khoản Claude | Khung **Claude 계정 연동** ở cuối trang → gõ một tên bất kỳ cho tài khoản → **[+ 계정 추가(로그인)]** | Đăng nhập tài khoản Claude trong trình duyệt, dán mã về dashboard. Chưa có bước này thì không viết bài được. |
| 2 | Blogger | **[발행 API 연동(구글 인증)]** ở cột Blogger | Đăng nhập **tài khoản Google sở hữu 4 blog medi** và bấm đồng ý. Bỏ qua bước này nếu quản lý đã gửi kèm `token.json`. |
| 3 | Tistory | **[티스토리 로그인(카카오)]** rồi **[카테고리 추출]** ở cột Tistory | Đăng nhập Kakao trong cửa sổ Chrome hiện ra. Không đóng cửa sổ đó giữa chừng; nó tự đóng khi xong. |
| 4 | Cột homepage | **[메디 관리자 로그인]** ở cột 홈페이지 칼럼 | Đăng nhập trang admin của medi.messeze.com trong cửa sổ Chrome hiện ra. |

Thông tin đăng nhập do quản lý cung cấp cho người dùng. Bạn không hỏi, không lưu và không nhập các mật khẩu này.

Khi xong, các chip ở đầu trang chuyển sang: `claude OK`, `블로거 API OK`, `티스토리 세션 OK`. Bạn có thể chạy lại `node selftest.js` để xác nhận mục **연동** đã `[ OK ]`.

## Phần 6 — Cách dùng hằng ngày (nói ngắn gọn cho người dùng)

1. Mở `RUN_dashboard.bat`.
2. Bấm **[1편 쓰기]** ở blog muốn viết, hoặc **[티스토리 4건 생성]** / **[블로거 4건 생성]** để viết cả 4 blog. Một bài mất khoảng 6–15 phút. Cột homepage: **[메디 칼럼 생성 (2편)]** (mỗi ngày 2 bài).
3. Bấm **[미리보기]** để đọc bài. Nếu cần: **[제목 다시]** (đặt lại tiêu đề), **[이미지 교체]** (đổi ảnh), **[다시 쓰기]** (viết lại).
4. Chỉ bài nào bấm **[발행]** mới được đăng. Viết bài xong thì bài chưa lên blog.
5. Nếu Tistory hiện captcha lúc đăng, người dùng tự giải trong cửa sổ Chrome; chương trình chờ và đăng tiếp.

## Phần 7 — Cập nhật và cài đặt riêng cho máy

- **Cập nhật**: tự động mỗi lần mở `RUN_dashboard.bat`. Muốn cập nhật khi đang chạy thì bấm **[업데이트 확인]** ở đầu dashboard; chương trình tự tải và khởi động lại. Bài đã viết, hàng chờ và các đăng nhập đều được giữ nguyên.
- **Cài đặt riêng cho máy này**: tạo file `C:\messeze-medi-auto\writer_config.local.json`, chỉ ghi những khoá muốn đổi. Ví dụ đổi cổng và bật tự viết bài lúc 7:30 mỗi sáng:

```json
{ "port": 5016, "autoDaily": true, "autoTime": "07:30", "tistory": { "autoDaily": true } }
```

Sau khi sửa file này phải đóng cửa sổ đen và mở lại `RUN_dashboard.bat`. Không sửa `writer_config.json`.

## Phần 8 — Xử lý lỗi thường gặp

| Hiện tượng | Cách xử lý |
|---|---|
| `node` không được nhận ra | Chưa cài Node.js, hoặc cài xong chưa mở lại cửa sổ PowerShell. |
| `npm install` lỗi mạng | Chạy lại lệnh. Nếu máy dùng proxy công ty, báo người dùng. |
| Cửa sổ đen báo `Cannot start ... port 5015 already in use` | Có chương trình khác đang dùng cổng 5015. Kiểm tra bằng `netstat -ano \| findstr :5015`. Nếu là bản messeze-medi-auto mở trùng thì đóng bớt; nếu là chương trình khác thì đổi cổng bằng `writer_config.local.json` (Phần 7). |
| Dashboard báo `claude 없음` | Chương trình không tìm thấy Claude Code. Bảo người dùng cài/cập nhật ứng dụng Claude desktop, rồi đóng cửa sổ đen và mở lại `RUN_dashboard.bat`. |
| Bấm viết bài báo `Not logged in` hoặc `모든 계정 소진/미로그인` | Chưa đăng nhập tài khoản Claude trên dashboard (Phần 5, bước 1), hoặc tài khoản hết hạn mức. Thêm tài khoản khác ở khung Claude 계정 연동. |
| Blogger báo `client_secret*.json 없음` | Chưa chép file từ quản lý vào thư mục chương trình (Phần 4.1). |
| Xác thực Google báo ứng dụng bị chặn / chưa xác minh | Dừng lại và báo quản lý kèm ảnh chụp màn hình. Không tìm cách vượt qua. |
| `[업데이트 확인]` báo lỗi | Chạy `RUN_update.bat` để xem thông báo đầy đủ; thường do mất mạng. |

## Việc cần báo lại cho người dùng khi cài xong

Tóm tắt trong vài dòng: chương trình cài ở đâu, mở bằng file nào, bước đăng nhập nào đã xong và bước nào còn thiếu (đặc biệt là file `client_secret.json` nếu chưa có).
