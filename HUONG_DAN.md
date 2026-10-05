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

## 3. Tìm kiếm thông minh trên ba nguồn

Host tìm các trang thuộc zingmp3.vn, nhaccuatui.com, youtube.com qua Brave Search API (cần BRAVE_SEARCH_API_KEY trong Environment). Đăng ký key tại https://api-dashboard.search.brave.com/ và kiểm tra hạn mức/chi phí của gói bạn chọn. Không đưa key vào repository.

Nếu chưa có key: chỉ có tìm kiếm YouTube bằng yt-dlp; Zing và NhacCuaTui sẽ báo thiếu cấu hình trong /candidates. Đây là tìm kiếm trang công khai được lập chỉ mục, không phải tìm toàn bộ cơ sở dữ liệu nội bộ của từng dịch vụ.

Xếp hạng: bỏ dấu, khớp từ trong tên bài, kiểm tra tên ca sĩ, cộng điểm official, trừ điểm remix/cover/karaoke/live khi bạn không yêu cầu. Thử tối đa 3 ứng viên đủ điểm để lấy luồng âm thanh; không tìm được luồng thì báo lỗi, không trả trang web làm audio. Có thể cần thêm aliases trong catalog nếu giọng nói nhận sai nhiều.

Xem kết quả và lỗi nguồn bằng `/candidates?song=L%E1%BA%A1c%20Tr%C3%B4i&artist=S%C6%A1n%20T%C3%B9ng%20M-TP`.

YouTube và Zing có extractor trong yt-dlp. NhacCuaTui dùng extractor generic nên chưa đảm bảo lấy được âm thanh; nếu không hỗ trợ, thêm source_url/file cho bài đó trong catalog. Danh sách hỗ trợ không bảo đảm mọi bài hoạt động. Render có thể bị YouTube chặn IP/yêu cầu đăng nhập; không tự vượt bước đăng nhập, giới hạn vùng, VIP hay DRM. Chỉ xử lý nội dung công khai truy cập được. Các nguồn chưa được thử live trong môi trường này.

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
