# Host nhạc DB-ROBOT MINI trên Render

Gói mã nguồn sẵn để triển khai, chưa phải host đã chạy trên Internet. Thiết kế cho ESP32-S3 dùng DB-ROBOT MINI. Giao thức mặc định dựa trên cấu trúc JSON trong mã host trước đây; cần thử trên robot để xác nhận phiên bản firmware của bạn. MAX98357A nhận I2S từ ESP32, không nhận trực tiếp MP3 qua mạng.

## 1. Đưa mã lên Render

1. Giải nén ZIP, tạo một repository GitHub của bạn.
2. Upload **các file bên trong thư mục xiaozhi-render** vào gốc repository, gồm cả thư mục music. Không chỉ upload ZIP.
3. Mở https://dashboard.render.com → New → Web Service → chọn repository.
4. Chọn Language/Runtime **Docker**. Dockerfile đã cài FFmpeg; không cần Build Command/Start Command riêng cho Node.
5. Chọn region gần bạn nếu có, chọn Free để thử, Health Check Path: `/health`.
6. Thêm Environment:

| Biến | Giá trị |
|---|---|
| RESPONSE_MODE | json |
| SAMPLE_RATE | 24000 |
| ENABLE_AUDIUS | false |
| ENABLE_WEB_SEARCH | true |
| BRAVE_SEARCH_API_KEY | Key Brave Search API của bạn |
| PUBLIC_BASE_URL | https://TEN-SERVICE.onrender.com |

Địa chỉ trên chỉ là mẫu. Dùng URL Render thực tế. Nếu chưa biết URL, có thể bỏ PUBLIC_BASE_URL lúc tạo: host tự lấy RENDER_EXTERNAL_URL nếu Render cung cấp, rồi bổ sung PUBLIC_BASE_URL sau.

7. Bấm Create Web Service; đợi deploy hoàn tất.
8. Mở URL host, tìm **Test loa** rồi bấm Play trong trình duyệt. Đây là tiếng thử 440 Hz ngắt quãng, dài 3 giây, âm lượng thấp, không phải bài nhạc.
9. Mở `https://TEN-SERVICE.onrender.com/health`: cần thấy `status: ok`.

Render Free ngủ sau 15 phút không có yêu cầu, có thể mất khoảng một phút để tỉnh lại. Mở trang host và đợi hoạt động trước khi gọi nhạc trên robot. Muốn tránh ngủ do không hoạt động, chọn compute plan trả phí phù hợp. Không thêm dịch vụ ping để lách giới hạn.

## 2. Cấu hình robot

Trong nơi firmware cho nhập host nhạc, nhập URL HTTPS thực tế của Render. Nếu trường yêu cầu địa chỉ host gốc, nhập `https://TEN-SERVICE.onrender.com`.

Không mặc định nối thêm `/stream_pcm` vào trường host: log robot cần cho thấy yêu cầu dạng `/stream_pcm?artist=...&song=...`. Tên trường và cách lưu cấu hình thay đổi theo bản firmware; gói này không thay firmware.

Thử lệnh: **“Phát bài Test loa”**. Kiểm tra Logs Render để thấy `[SEARCH]` và tiếp theo `[AUDIO]`.

| Log / triệu chứng | Cách xử lý |
|---|---|
| Không thấy SEARCH | Kiểm tra host trong robot, Wi-Fi, khả năng HTTPS và host đã tỉnh |
| SEARCH có, AUDIO không có | Có thể firmware chờ âm thanh trực tiếp thay vì JSON; thử RESPONSE_MODE=mp3 rồi deploy lại |
| Firmware xác nhận chờ PCM thô | Đổi RESPONSE_MODE=pcm; sample rate phải khớp firmware |
| Có AUDIO, nghe nhanh/chậm hoặc nhiễu | Kiểm tra định dạng, sample rate, cấu hình I2S trong firmware |
| Trình duyệt nghe được, robot im | Kiểm tra khả năng HTTPS, parser URL/JSON và cấu hình loa; cần log serial để xác định |
| Lỗi 404 khi tìm | Chưa có bài phù hợp; thêm catalog hoặc thử tên khác |
| Lỗi 502 | Xem Logs: nguồn nhạc/API không truy cập được hoặc FFmpeg báo lỗi |
| Lỗi 429 | Đang vượt 2 luồng chuyển mã đồng thời |

Endpoint `/stream_pcm` có 3 chế độ, tên endpoint không chứng minh dữ liệu là PCM:

* `json` (mặc định): trả thông tin bài và đường dẫn MP3, theo cấu trúc mã host cũ.
* `mp3`: trả MP3 trực tiếp.
* `pcm`: trả PCM signed 16-bit little-endian, mono, không WAV header.

`/search?song=...` luôn trả JSON cho trang nghe thử. `/audio?provider=catalog&id=test&format=mp3` phát bài thử. Sample rate mặc định 24 kHz, MP3 64 kbps; đây là cấu hình ban đầu, không phải thông số đã xác nhận của firmware.

## 3. Tìm kiếm thông minh trên nhiều nguồn

ZingMP3 được tìm trực tiếp bằng client cộng đồng đã ghim phiên bản trong `package-lock.json`; không cần Brave key; mặc định dùng phiên ẩn danh. Chỉ giữ ứng viên khi API trả URL HTTPS ở mức `128 kbps`; bài không có mức 128, bị VIP, không có quyền theo vùng hoặc không lấy được luồng sẽ bị bỏ qua. Không lấy 320 kbps làm dự phòng, chế độ dùng phiên tài khoản được mô tả ở mục bên dưới. Zing là nguồn cuối để các nguồn đang chạy được thử trước. Tắt riêng nguồn này bằng `ENABLE_ZINGMP3=false`.

NhạcCủaTui cũng được tìm qua API công khai, SoundCloud qua yt-dlp, Audius / Internet Archive qua API của từng nguồn. YouTube dùng `YOUTUBE_API_KEY` khi bật `ENABLE_YOUTUBE=true`. Luồng tìm kiếm hiện tại không cần `BRAVE_SEARCH_API_KEY`. Trang `/candidates` chỉ kiểm tra nhóm nguồn trong `searchWeb`; dùng `/search?song=...` để thử luồng tìm kiếm đầy đủ, và xem log `[ZING SEARCH]` khi các nguồn trước không tìm được bài.

Xếp hạng: bỏ dấu, khớp từ trong tên bài, kiểm tra tên ca sĩ, cộng điểm official, trừ điểm remix/cover/karaoke/live khi bạn không yêu cầu. Thử tối đa 3 ứng viên đủ điểm để lấy luồng âm thanh; không tìm được luồng thì báo lỗi, không trả trang web làm audio. Có thể cần thêm aliases trong catalog nếu giọng nói nhận sai nhiều.

Xem kết quả và lỗi nguồn bằng `/candidates?song=L%E1%BA%A1c%20Tr%C3%B4i&artist=S%C6%A1n%20T%C3%B9ng%20M-TP`.

YouTube và SoundCloud dùng yt-dlp để lấy nguồn phát. Zing dùng trực tiếp URL 128 kbps do API xác nhận, lưu tối đa 60 giây rồi lấy lại; NhạcCủaTui dùng URL MP3 công khai từ API. Render có thể bị YouTube chặn IP/yêu cầu đăng nhập; Zing có thể trả lỗi không khả dụng theo quốc gia của máy chủ. Lỗi quốc gia của một bài chỉ loại luồng của bài đó; host vẫn tìm được metadata và tiếp tục kiểm tra các bài khác. Không tự vượt bước đăng nhập, giới hạn vùng, VIP hay DRM. Render đã tải hoàn chỉnh Sóng Gió và Bạc Phận 128 kbps khi API qua proxy Việt Nam và CDN được tải trực tiếp. Chế độ tài khoản trực tiếp chưa được xác nhận với phiên thật.

Tìm nguồn và kiểm tra ứng viên có thể mất vài chục giây: timeout firmware có thể ngắn hơn. Với bài hay nghe, thêm catalog để bỏ qua tìm kiếm. Không bảo đảm nguồn online chạy ổn định 24/7. Có thể tắt bằng ENABLE_WEB_SEARCH=false.

## 4. Thêm bài nhạc

Nguồn Audius là tùy chọn tìm kiếm trực tuyến được kế thừa từ host trước. Chưa kiểm chứng API/khả năng phát từ Render trong môi trường này. Nếu Audius yêu cầu key, thêm AUDIUS_API_KEY trong Environment; có thể chỉnh AUDIUS_API_BASE theo tài liệu nhà cung cấp. Tắt bằng ENABLE_AUDIUS=false nếu chỉ dùng danh mục riêng. Không đảm bảo tìm đủ nhạc Việt, đúng bản gốc hay mọi bài hát.

Để có bài chắc chắn theo tên, chỉnh catalog.json. Mỗi id phải khác nhau:

```json
[
  {"id":"test","title":"Test loa","artist":"Host test","source_file":"music/test.wav","duration":3,"aliases":["kiem tra loa","test"]},
  {"id":"bai-1","title":"Tên bài","artist":"Tên ca sĩ","source_url":"https://YOUR-AUDIO-HOST/song.mp3","aliases":["ten bai khong dau"]}
]
```

Thay YOUR-AUDIO-HOST bằng link âm thanh trực tiếp HTTPS mà bạn có quyền sử dụng. Link trang YouTube, Spotify, trang nghe nhạc hoặc trang chia sẻ Google Drive không phải link file âm thanh trực tiếp. Chỉ cấu hình nguồn tin cậy của bạn.

Cũng có thể upload file `music/bai-1.mp3` vào repository, dùng `source_file: "music/bai-1.mp3"` thay source_url rồi deploy lại. File chứa trong repository/image sẽ có lại khi redeploy. File upload thêm vào ổ đĩa đang chạy trên Render Free không được lưu bền vững. Lưu ý repository công khai cũng công khai những file nhạc đó.

Host bỏ dấu tiếng Việt để tìm tên, ưu tiên trùng tên đầy đủ. Khi chỉ định ca sĩ, kết quả phải chứa tên ca sĩ trong artist hoặc title. Nếu không khớp, trả 404 thay vì tự chọn bài bất kỳ.

## 5. Đấu MAX98357A

| Chân MAX98357A | Nối tới |
|---|---|
| VIN | Nguồn phù hợp module, thường 5 V; IC hỗ trợ 2,5–5,5 V |
| GND | GND chung với ESP32-S3 |
| BCLK | GPIO I2S BCLK đã khai báo trong firmware |
| LRC / LRCLK | GPIO I2S WS/LRCLK đã khai báo trong firmware |
| DIN | GPIO I2S DOUT đã khai báo trong firmware |
| SPK+ / SPK− | Hai đầu loa; không nối SPK− xuống GND |

Không chọn số GPIO khi chưa biết sơ đồ board và cấu hình firmware: màn hình, mic, camera có thể chiếm chân. MAX98357A không cần MCLK. SD/GAIN phụ thuộc module: đối chiếu hướng dẫn của mạch cụ thể.

## 6. Thử tại máy tính

Cài Node.js >=22, Python >=3.10, yt-dlp (python3 -m pip install "yt-dlp[default]") và FFmpeg trong PATH rồi chạy `npm start` trong thư mục này; mở http://localhost:10000. Không cần npm install vì không có dependency npm. Docker build/run cũng dùng được nếu đã cài Docker.

Giới hạn mặc định: 2 luồng chuyển mã đồng thời, mỗi luồng tối đa 15 phút. URL audio từ catalog dùng id cố định, không dùng token RAM nên không mất token khi host khởi động lại. Luồng chuyển mã không hỗ trợ tua bằng Range; host trả 200 với Accept-Ranges:none.

## Tài liệu tham khảo

* https://render.com/docs/web-services
* https://render.com/docs/free
* https://www.analog.com/en/products/max98357a.html
* https://docs.audius.co/api/
* https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md
* https://api-dashboard.search.brave.com/app/documentation/web-search/get-started

Đã kiểm tra cả 3 chế độ JSON/MP3/PCM bằng file thử local: MP3 mono 24 kHz, PCM 16-bit mono 24 kHz đúng số byte; kiểm tra 404 khi không có bài và logic xếp hạng tên/ca sĩ/phiên bản. Chưa triển khai vào tài khoản Render và chưa kiểm tra thiết bị ESP32-S3 thực tế.


## Thử riêng nguồn Zing MP3

Dùng `/search?song=Sóng%20Gió&source=zingmp3` hoặc nói “mở bài Sóng Gió trên Zing MP3”. Yêu cầu có nguồn Zing sẽ chỉ thử Zing, để không trả nhầm kết quả từ nguồn khác. Tìm nhạc thông thường vẫn giữ thứ tự nguồn cũ.

Dùng `/candidates?song=Sóng%20Gió&source=zingmp3` để xem bài tìm được, ca sĩ và khả năng phát. `playable=false` với `reason=region_restricted` và `code=-1110` nghĩa là Zing tìm thấy bài nhưng không cho host hiện tại lấy âm thanh. `no_public_128` nghĩa là không có luồng 128 kbps công khai. Không trả bài bị hạn chế như một kết quả có thể nghe được.


## Nguồn âm thanh công khai mở rộng

Host giữ nguyên giao thức JSON và âm thanh MP3 128 kbps cho firmware hiện tại. NhạcCủaTui tiếp tục là nguồn mặc định; ccMixter và Wikimedia Commons bổ sung vào nhóm dự phòng cùng Audius và Internet Archive. Không cần tài khoản hay API key cho hai nguồn mới.

- Thử `a night flight trên ccMixter`, hoặc `/search?song=a%20night%20flight&source=ccmixter`.
- Thử `/candidates?song=Moonlight&source=commons` để xem kết quả Commons.
- `source=open` chỉ tìm nhóm nguồn mở. JSON trả thêm license, license_url và attribution_url khi nguồn cung cấp.
- Nguồn mở không đảm bảo có bài nhạc Việt thương mại; host vẫn so khớp tên bài và ca sĩ, không tự thay bằng bài khác.
- Chỉ nhận MP3 trực tiếp từ ccMixter và tệp âm thanh công khai trên Wikimedia Commons. Luồng tải về được kiểm tra và chuyển sang MP3 128 kbps bằng ffmpeg.
- Openverse chưa được bật vì API trả 403 trong môi trường thử. Zing vẫn bị hạn chế vùng với các bài đã thử trên Render Singapore; thêm nguồn khác không khắc phục quyền phát Zing.


## Proxy Việt Nam riêng cho Zing MP3

### Thử phiên đăng nhập qua kết nối trực tiếp

Biến bí mật `ZING_SESSION_COOKIE` nhận giá trị của header `Cookie` từ phiên Zing MP3 của chính bạn. Chỉ cấu hình trong Render Environment; không gửi cookie, mật khẩu hoặc OTP trong chat, không ghi vào GitHub. Cookie có quyền truy cập tài khoản và có thể hết hạn; bản này không tự đăng nhập Zalo hoặc tự gia hạn phiên.

Khi biến này có giá trị, API Zing dùng phiên đó qua HTTPS trực tiếp, bỏ qua `ZING_PROXY_URL` dù proxy vẫn còn trong cấu hình. Không lấy cookie ẩn danh trước mỗi phiên API; không gửi cookie tài khoản cho CDN âm thanh hay proxy. Yêu cầu chỉ được gửi đến hai endpoint tìm kiếm và lấy luồng trên `zingmp3.vn`, không theo redirect mang theo cookie. Xóa `ZING_SESSION_COOKIE` để trở lại cấu hình trước.

Đây là chế độ thử nghiệm chưa xác nhận với tài khoản thật. Đăng nhập không có nghĩa IP Render được cấp quyền nghe bài bị giới hạn vùng: mã `-1110` vẫn được giữ là `region_restricted`. Kiểm tra bằng cùng bài trên `/candidates` rồi `/search`, xác nhận log `AUDIO READY`/`PLAY READY` và nghe trên ESP32. Không kết luận thành công chỉ từ HTTP 200 của âm báo chờ.

Đặt biến môi trường bí mật `ZING_PROXY_URL` trên Render với dạng `http://USERNAME:PASSWORD@HOST:PORT` hoặc proxy HTTPS. Ký tự đặc biệt trong username/password cần URL-encode. Không ghi giá trị thật vào GitHub hoặc gửi trong chat.

Khi biến này được cấu hình, cả phiên truy cập ẩn danh, tìm kiếm, lấy luồng Zing và tải âm thanh Zing đều đi qua cùng proxy. Cấu hình này không đổi địa chỉ Custom MUSIC URL của firmware. Không đặt global HTTP_PROXY cho toàn bộ ứng dụng. Bỏ ZING_PROXY_URL để quay lại kết nối trực tiếp. Hỗ trợ HTTP/HTTPS CONNECT, không hỗ trợ SOCKS ở bản này.

Nếu API qua proxy lấy được URL 128 kbps nhưng proxy không tải được âm thanh, có thể thử `ZING_PROXY_AUDIO=false`: phiên và API Zing tiếp tục qua proxy, Render tải MP3 trực tiếp. Chỉ bật chế độ này sau khi kiểm tra CDN chấp nhận URL từ IP Render; không mặc định giả định URL dùng được ở IP khác.

Chẩn đoán một lần lúc khởi động: `ZING_PROXY_CHECKS` là tối đa 20 URL proxy HTTP/HTTPS công cộng, phân cách bằng dấu phẩy, không chứa username/password. Kết quả đọc tại `/zing-proxy-check`; mỗi proxy thử tối đa 35 giây, 4 phép thử song song. Chẩn đoán không tự chọn proxy phát nhạc. Bỏ biến này sau khi thử để tránh lặp lại khi dịch vụ khởi động.

Yêu cầu proxy có IP ra Internet tại Việt Nam, hỗ trợ HTTPS CONNECT, và đủ băng thông âm thanh. Ưu tiên phiên IP cố định trong lúc lấy URL và tải bài. Chỉ kiểm tra luồng công khai 128 kbps; không thay quyền truy cập VIP. 128 kbps tương đương khoảng 57.6 MB/giờ chưa tính overhead; proxy có tính phí theo dung lượng cần dự trù trước.

Kiểm tra `/candidates?song=S%C3%B3ng%20Gi%C3%B3&source=zingmp3` rồi `/search?song=S%C3%B3ng%20Gi%C3%B3&source=zingmp3` và URL audio trả về. Tiêu chí đạt: API Zing err=0 có 128, host audio HTTP 200 audio/mpeg, sau đó nghe trên ESP32. Nếu chưa có proxy hoạt động thì chưa xác nhận vượt hạn chế vùng.
