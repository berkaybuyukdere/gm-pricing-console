# GM Pricing Console — Sistem Dokümantasyonu

Green Motion Zürih'in FuseMetrix Dynamic Pricing System (FMX DPS) üzerindeki
haftalık fiyat kurallarını hızlı yönetmek ve rentalcars.com pazarını canlı
izlemek için geliştirilmiş yerel web paneli.

## 1. Mimari

```
Tarayıcı (localhost:4646)
   │  Palantir tarzı SPA — public/index.html + app.js + style.css
   ▼
Node.js / Express (server.js)
   │  ├─ lib/fmx.js  → zrh.dps.greenmotion.com  (FMX oturumu, kural CRUD)
   │  └─ rcQuery     → rentalcars.com/api/search-results  (pazar verisi)
   ▼
Yerel durum dosyaları (.gitignore'da):
   .session            FMX oturum çerezi
   .secrets.json       SMTP ayarları (şifre dahil — asla commit edilmez)
   .cache-details.json FMX kural detay önbelleği (ruleid + Date Updated)
   .rc-cache.json      rentalcars cevap önbelleği (gün+süre başına)
   .rc-watch.json      Market Watch temel çizgisi (baseline)
   .logs.json          Aktivite logu (kim/ne zaman/ne idi→ne oldu)
   .backups/           Geri dönüş noktaları (tüm kuralların anlık görüntüsü)
```

## 2. FMX entegrasyonu (API yok — form protokolü)

FuseMetrix'in resmi API'si yoktur; panel, FMX arayüzünün kendi kullandığı PHP
form uçlarını birebir taklit eder (gerçek trafiği izleyerek keşfedildi):

| İşlem | Yol |
|---|---|
| Giriş | `GET /` (dinamik `username_<n>` alan adı çözülür) → `POST /home/login.php` |
| Kural listesi | `GET /bespoke/rate_manager/weekly_rules.php?vehicle_override_location_id=<istasyon>` |
| Kural detayı | `GET /bespoke/rate_manager/weekly_rules_edit.php?ruleid=N` |
| Oluştur | `POST weekly_rules_edit.php` + `ruleid=0` |
| Güncelle | aynı POST + `ruleid=N` |
| Sil | `GET weekly_rules.php?bulkdelete=true&recids=N` |

Kritik ayrıntılar:

- **İstasyon bağlamı sunucu oturumunda taşınır**: yeni kural, en son hangi
  istasyonun listesi açıldıysa oraya bağlanır. Bu yüzden her create'ten önce
  hedef istasyonun listesi GET'lenir ve tüm yazmalar tek kuyruktan geçer.
- **Kural semantiği**: 2–5 gün `NumDaysOp "="`, 6 gün `">= 6"` (6+ kuralı);
  vendor varsayılan `ALL` (panelden kanal seçilebilir); tüm araç grupları;
  tarih penceresi `00:01–23:59`; isim şablonu `GG-----AA------01-----S`.
- **Doğrulamalı yazma**: her yazmadan sonra kural geri okunur; yüzde, tarih,
  süre, operatör ve vendor birebir karşılaştırılır, uyuşmazlık UI'da ve logda
  gösterilir.
- **Oturum bakımı**: 4 dakikada bir keep-alive; oturum düşerse bellekteki
  bilgilerle otomatik yeniden giriş yapılır ve istek tekrarlanır (şifre diske
  yazılmaz).

## 3. Fiyatların rentalcars'a akışı (pull modeli)

FMX'te Save yalnızca veritabanını günceller; hiçbir push yoktur. Rentalcars,
Green Motion'ın XML fiyat motoruna (bespoke/price_engine) kendi sorgusunu
attığında yeni fiyat hesaplanır: Taban fiyat → günlük Price Override →
eşleşen kurallar (senin yüzdenler) → XML cevap. Rentalcars kendi teklif
önbelleğini tazeleyene kadar (dakikalar) sitede eski fiyat görünebilir —
bkz. §7 Canlı Senkron.

## 4. Panel sayfaları

- **DASHBOARD** (açılış): stat tile'ları (bugünkü GM sırası, pazar lideri,
  Market Watch durumu, restore point sayısı), istasyon kartları (ortalama /
  min–maks / kapsama çubuğu), **RC MARKET RANK** şeridi (ayın her günü için
  GM'in sırası, 6 saat önbellekli akış), fiyat eğrisi, restore points,
  Market Watch kartı, son aktiviteler.
- **PRICING GRID**: gün × süre (2/3/4/5/6+) matrisi. Hücreye yaz → staged →
  APPLY. Sütun/satır doldurma, COPY → (ayı başka aya kopyala), TOP-10 SWEEP,
  vendor seçici, kapsanmayan gün uyarıları, ⌕ analiz butonu, sağ tık →
  rentalcars karşılaştırma (en düşük fiyat sıralı, saat rotasyonu
  19:00→16:00).
- **ANALYTICS**: büyük fiyat eğrisi (renk körlüğü doğrulanmış 5 seri palet,
  TODAY işareti, hover crosshair+nokta) + süre bazlı avg/min/max.
- **ACTIVITY**: tam log — zaman, kullanıcı, istasyon, hedef tarih/süre,
  işlem, eski→yeni değer, durum; her satırda **REVERT**.

## 5. Rakip analizi (⌕ ve sıralama yerleştirme)

Rentalcars'ın arama sayfasının kullandığı herkese açık
`/api/search-results` ucuna düz GET atılır (kimlik doğrulaması yok).
Cevap: eşleşme listesi + depot→tedarikçi eşlemesi + puanlar. Panel top-10'u
kendi tasarımıyla, tedarikçi logolarıyla (monokrom filtre) gösterir.

**Yerleştirme matematiği**: hücrenin mevcut yüzdesi C ve GM'in listedeki
fiyatı P biliniyorsa taban `B = P / (1 + C/100)`. Hedef pozisyondaki rakibin
fiyatının ~%0,5 altı hedeflenir; yeni yüzde `(hedef/B − 1) × 100`. CONFIRM →
FMX'e yazılır, doğrulanır, loglanır.

**TOP-10 SWEEP**: ayın aranabilir her günü × seçili süreler (maks 6 gün)
taranır; GM hedef sıranın dışındaysa gereken yüzde hesaplanıp plana eklenir;
plan onaylanınca satır satır uygulanır. Fiyat asla yükseltilmez.

## 6. Market Watch (e-posta uyarıları)

Saatte bir, iki istasyon × 14 gün taranır ve `.rc-watch.json` temel çizgisiyle
karşılaştırılır. Tetikleyiciler: top-5 tedarikçi fiyatında ±%5, GM sırasında
2+ pozisyon, liderlik değişimi. Değişiklikler tek özet mailde (Palantir tarzı
koyu HTML) `.secrets.json`'daki SMTP ile gönderilir. Not: Microsoft 365'te
SMTP AUTH hem kiracı hem posta kutusu düzeyinde açık olmalı; Security
Defaults kapalı olmalı ya da app password kullanılmalıdır.

## 7. Önbellekler ve Canlı Senkron

| Katman | Anahtar | Ömür | Amaç |
|---|---|---|---|
| FMX detay | ruleid + Date Updated | süresiz (damga değişince düşer) | grid yüklemesini saniyeler altına indirir |
| Ay önbelleği (istemci) | istasyon+yıl+ay | oturum boyu | ay geçişleri anında; arka planda tazelenir |
| rentalcars | istasyon+tarih+süre | modal 10 dk / ay taraması 6 sa | RC'ye nazik davranır, taramaları hızlandırır |
| rentalcars'ın kendisi | onların tarafında | dakikalar | bizim kontrolümüzde değil |

**Canlı Senkron**: bir yerleştirme/sweep FMX'e yazıldığında o günün RC
önbelleği anında silinir ve 2/5/10. dakikalarda taze sorguyla GM fiyatının
hedefe (%2,5 tolerans) düşüp düşmediği kontrol edilir. Canlıya geçince
toast + rank şeridi güncellenir; modalda CHECK NOW ile elle de bakılabilir.

## 8. Kurulum ve yapılandırma

```bash
npm install
npm start        # http://localhost:4646
```

- İstasyonlar/süreler: `server.js` başındaki `STATIONS` / `DURATIONS`.
- Watcher ayarları: `server.js` içindeki `WATCH` (aralık, gün sayısı, eşikler).
- SMTP: `.secrets.json` (`smtp.host/port/user/pass/from/to`).
- HUD ölçeği, tema, saat rotasyonu tarayıcı localStorage'ında tutulur.
