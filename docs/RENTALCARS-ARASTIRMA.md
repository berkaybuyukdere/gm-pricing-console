# Green Motion Zürich — rentalcars.com Rezervasyon Artırma Raporu

**Tarih:** 26 Ağustos 2026 · **Veri:** 26.08.2026 tarihinde bu makineden (CH residential IP) `https://www.rentalcars.com/api/search-results` public endpoint'ine yapılan **68 canlı çağrı** — ZRH (IATA) + Zürih merkez (LATLONG), süreler 1/3/7/14 gün, alış saati 19:00, sürücü yaşı 30 (+22 ve 70 kontrol çekimleri), alış tarihleri **27.08.2026 – 10.05.2027**. Ham JSON'lar: `/private/tmp/claude-501/-Users-berkaybuyukdere-PRICINGSENTINEL/dba47f2e-8d86-4c96-a2e6-eeea3c1be635/scratchpad/rc/`. Analiz script'leri aynı klasörde (`an1.js`…`an8.js`, `pull2.js`).
Repo'da hiçbir dosya değiştirilmedi.

---

## 0. Yönetici özeti (3 cümle)

Green Motion ZRH, **26 Ağustos – 16 Kasım 2026** aralığında 3 ve 7 günlük kiralamalarda fiyat merdiveninin **1 numarası** ve rakiplerinden %6–24 daha ucuz — yani bu pencerede sorun görünürlük değil, masada bırakılan marj. Buna karşılık **17 Kasım 2026'dan itibaren fiyatlar 2,45×, 1 Aralık'tan itibaren 4,3× katlanıyor** (rank 80–194 = pratikte görünmez) ve **1 Ocak 2027'den sonra Green Motion listede hiç yok** — yani ileri tarihli talebin tamamı kaybediliyor. Kalıcı dönüşüm kaybının kaynağı ise fiyat değil: **390 yorumla 8,1 puan, 7,5 "value for money" (en ucuz tedarikçi olmasına rağmen sondan üçüncü), tek shuttle depo, 0 EV, 0 minivan/7 koltuk, 0 online check-in.**

---

## 1. rentalcars.com sıralama ve sunum mekaniği (kaynaklı)

**Doğrulanmış (kaynak + canlı veri):**

- Varsayılan sıralama **"Recommended"**; rentalcars kendi açıklamasında "price, ratings, size, profit, car specs and more" ağırlıklandıran "ever-changing algorithm" diyor ve bir aracın **click-through rate'i ile rezervasyon sayısının "often play a large role"** olduğunu belirtiyor. Alternatif sıralamalar: Price, Rating, Distance ([rentalcars.com/en/how-we-work](https://www.rentalcars.com/en/how-we-work), [booking.com/content/how_we_work.html](https://www.booking.com/content/how_we_work.html)).
- **Recommended ≠ ucuzdan pahalıya.** Canlı kanıt (15.10.2026, d3): GM 96.32 CHF → `recommendedDisplayOrder` #1; **#2 sıra Dollar 110.59 CHF (+%15)**, oysa GM'in 98.21 CHF'lik aracı listede mevcut. Algoritma tedarikçi/kategori çeşitlendirmesi yapıyor.
- API'de `filterCriteria` **hiç gönderilmezse** gerçek Recommended sırası dönüyor; `sortBy:"PRICE"` gönderilirse `recommendedDisplayOrder` fiyat sırasına eşitleniyor. `sortBy:"RECOMMENDED"` ve `"POPULARITY"` HTTP 400 veriyor; geçerli değerler `PRICE` ve `RATING`. **Konsolun bugün ölçtüğü rank, müşterinin gördüğü rank değil.**
- Puanlama: kiralamadan sonra gönderilen "welcome home survey", 10 üzerinden alt kırılımlarla (helpful staff, car condition, value for money…). API'de depo bazında `rating.{average, numRatings, valForMoney, cleanliness, condition, collectTime, dropOffTime, efficiency, locating}` olarak geliyor.
- **Filtre eşikleri canlı veriden:** `supplierRatings` kovaları 5/6/7/**8**/9_OR_ABOVE. 15.10 çekiminde 8+ filtresi 243 aracın 210'unu bırakıyor; **GM 8,1 ile bu eşiği 0,1 puanla geçiyor.**
- `depotLocationTypes`: SHUTTLE_BUS 23 araç (**tamamı GM**), IN_TERMINAL 145, CAR_RENTAL_CENTRE 75. **ZRH'de shuttle kullanan tek tedarikçi Green Motion** → konum tipi filtresi kullanan her müşteri GM'i %100 eliyor.
- Rozet/özellik alanları: `freeCancellation` (ZRH'de 219/219 tedarikçide true — ayrıştırıcı değil), `payWhen` (hepsi PAY_NOW), `mileageType` (hepsi UNLIMITED), `fuelPolicy` (hepsi RETURN_SAME), `preRegistrationSupported` (online check-in), `skipCounter`, `appliedPromotions` (üstü çizili fiyat + "% discount applied"), `sponsoredSlot.sponsoredVehicle`.
- **Reklam/sponsorlu slot:** incelenen ~4.000 satırın tamamında `sponsoredVehicle:false` → ZRH'de bu örneklemde ücretli slot yok. Booking tarafında "Ad" rozeti ve "commission paid on bookings and other factors may affect product rankings" ifadesi mevcut ([booking.com](https://www.booking.com/content/how_we_work.html)).

**Makul hipotez (kanıtlanmadı):** GM'in Recommended'da top-20'de 6 slot alması (listelerin %9,5'i olmasına rağmen ≈3× fazla temsil) fiyat liderliğinin algoritmada güçlü ağırlığı olduğunu gösteriyor; ama CTR/booking geri beslemesi nedeniyle **düşük dönüşüm zamanla bu avantajı eritir.**

---

## 2. Green Motion ZRH'nin gerçek konumu (canlı veri)

### 2.1 Depo ve puan karşılaştırması (15.10.2026, d3, 243 araç)

| Tedarikçi | Konum tipi | Puan | Yorum | val4money | temizlik | araç sayısı | en ucuz | depozito | muafiyet | online check-in |
|---|---|---|---|---|---|---|---|---|---|---|
| **Green Motion** | **SHUTTLE_BUS** | **8,1** | **390** | **7,5** | **8,5** | 23 | **96,32** | 400 | 2500–3500 | **0/23** |
| Dollar | IN_TERMINAL | 8,5 | 1578 | 7,7 | 9,1 | 12 | 108,32 | 750–1500 | 2750–5500 | 0/12 |
| Thrifty | IN_TERMINAL | 8,4 | 1516 | 7,8 | 9,1 | 11 | 110,59 | 750–1500 | 2750–5500 | 0/11 |
| Alamo | IN_TERMINAL | 8,3 | 4288 | 7,7 | 8,9 | 30 | 112,82 | 1000–1500 | 1622–3243 | 30/30 |
| Hertz | IN_TERMINAL | 7,7 | 1672 | 6,8 | 8,4 | 21 | 113,83 | 750–5000 | 2750–5500 | 21/21 |
| Budget | CAR_RENTAL_CENTRE | 8,6 | 3228 | 7,9 | 9,3 | 15 | 117,00 | **200** | 2750–6600 | 15/15 |
| Unirent | IN_TERMINAL | **9,1** | 2438 | **8,8** | 9,5 | 8 | 118,53 | 350–1000 | 2342–4000 | 0/8 |
| Enterprise | IN_TERMINAL | 8,4 | 1886 | 7,8 | 9,0 | 30 | 130,66 | 1500–3000 | 1622–3243 | 30/30 |
| Europcar (CRC) | CAR_RENTAL_CENTRE | 8,8 | 4702 | 7,8 | 8,6 | 33 | 132,73 | 350–6000 | 2000–9368 | 0/33 |
| Avis | CAR_RENTAL_CENTRE | 8,5 | 828 | 7,8 | 9,1 | 15 | 138,32 | **200** | 2750–6600 | 15/15 |
| Sixt | IN_TERMINAL | 8,8 | 1143 | 7,9 | 9,3 | 25 | 147,97 | 300–750 | 2500–5000 | 25/25 |

Kritik okuma: **GM ZRH'nin en ucuz tedarikçisi ama "value for money" puanı 7,5 ile sondan üçüncü** (yalnız Hertz 6,8 ve Flizzr 6,6 daha kötü). Bu, tezgâhta yaşanan deneyimin (upsell, depozito iadesi, hasar kesintisi) fiyat avantajını yediğinin doğrudan göstergesi — dış kaynaklardaki şikâyet temalarıyla da örtüşüyor ([Trustpilot greenmotion.ch](https://www.trustpilot.com/review/greenmotion.ch)). Buna karşılık `collectTime` 8,1 ile Alamo (7,3), Hertz (7,3), Enterprise (7,6) ve Europcar'ın (7,6) **üzerinde** — yani shuttle'ın kendisi puanı öldürmüyor, tezgâh deneyimi öldürüyor.

### 2.2 Süreye göre fiyat eğrisi (sağlıklı tarihler, CHF/gün, en ucuz teklif)

| Tarih | d1 GM/piyasa | d3 GM/piyasa | d7 GM/piyasa | d14 GM/piyasa |
|---|---|---|---|---|
| 10.09 | 74,1 / 62,0 → **119** | 33,9 / 42,0 → 81 | 25,4 / 29,9 → 85 | 25,6 / 27,6 → 93 |
| 24.09 | 75,4 / 57,9 → **130** | 30,5 / 41,9 → 73 | 24,7 / 29,9 → 83 | 24,1 / 27,6 → 87 |
| 15.10 | 79,6 / 56,6 → **141** | 32,1 / 36,1 → 89 | 26,4 / 27,1 → 97 | 24,1 / 24,0 → 100 |
| 12.11 | 82,3 / 59,5 → **138** | 31,1 / 38,8 → 80 | 30,3 / 27,2 → 111 | 29,5 / 24,9 → **118** |

Konsolun kanonik "kategori faktörü" (hedef rank 3) ortalamaları:
- **d1 → 0,71** (top-3 için −%29 gerekiyor; rank 9–33 arası)
- **d3 → 1,06** (%6 zam yapılabilir, hâlâ her kategoride top-3)
- **d7 → 0,99** (denge)
- **d14 → 0,92** (−%8 gerekiyor)

**Aynı günde faktör d1 için 0,63, d3 için 1,00 çıkabiliyor — 1,6× fark.** Konsol bugün yalnızca `durations:[3]` tarıyor.

### 2.3 Kategori bazında (sağlıklı tarihler, d3)

| Kategori | GM sırası | GM araç | rakip araç | GM fiyat | lider fiyat | fark | lider |
|---|---|---|---|---|---|---|---|
| economy | **1,0** | 4,2 | 14,8 | 101 | 121 | **+%20** | Unirent |
| compact | **1,3** | 8,3 | 55,2 | 121 | 134 | +%11 | Dollar |
| intermediate | **1,2** | 2,5 | 35,2 | 144 | 161 | +%12 | Unirent |
| standard | **1,4** | 2,4 | 28,2 | 131 | 140 | +%7 | Hertz |
| estate | **1,0** | 1,0 | 42,0 | 128 | 156 | **+%22** | Alamo |
| suvs | **1,3** | 6,3 | 66,3 | 136 | 144 | +%6 | Alamo |
| premium | 1,8 | 1,3 | 28,2 | 199 | 204 | +%2 | Europcar |
| **full_size / luxury / carriers / carriers_7/8/9 / special / convertible / mini** | **yok** | **0** | 12,8 / 22,1 / 24,5 / 10,5 / 3,3 / 7,6 / 2,8 / 1,0 / 2,2 | — | 236 / 257 / 196 / 249 / 490 / 282 / 336 / 260 / 117 | — | — |

GM: 7 kategori, maksimum 5 koltuk, 25 araç. Europcar 15 kategori, Hertz 13, Alamo/Enterprise/Sixt/Budget/Avis 12, 9 koltuğa kadar. `seatCapacity` filtresi: 6_TO_7 = 15 araç, 8_TO_9 = 12 araç → **GM her ikisinde de sıfır.**

### 2.4 Kritik kırılma noktaları (canlı, gün gün doğrulandı)

| Alış tarihi (d3) | GM en ucuz | GM rank | Piyasa #1 |
|---|---|---|---|
| 16.11.2026 | **96,32** | **1** | GM |
| **17.11.2026** | **236,32 (×2,45)** | **131** | Budget 113,53 |
| 30.11.2026 | 228,40 | 137 | Budget 104,30 |
| **01.12.2026** | **415,26 (×4,31)** | **194** | Budget 110,96 |
| 20.12.2026 | 416,99 | 80 | Budget 154,17 |
| 27.12.2026 | 415,26 | 5 | Europcar 391,88 |
| **05.01 – 10.05.2027** | **listede yok** | — | Unirent/Budget/Enterprise |

Tüm GM merdiveni aynı çarpanla ölçekleniyor (Clio 93,28 → 229,35 → 415,26; Volvo XC40 194,51 → 869,40) → **tek bir multiplicative kural**, araç bazlı yield değil. 27.08 – 16.11 = 83 gün satılabilir; 17.11 – 31.12 = 45 gün görünmez; 01.01.2027 sonrası = tamamen yok. **12 aylık booking penceresinin yaklaşık %23'ünde satılabilir durumda.**

### 2.5 Yakın vadeli stok deliği (d3, listelenen araç sayısı)

| | 27.08 (T+1) | 31.08 (T+5) | 07.09 (T+12) | 24.09 (T+29) | 15.10 (T+50) |
|---|---|---|---|---|---|
| **Green Motion** | **3 (%13)** | 14 (%61) | 17 (%74) | 22 (%96) | 23 (%100) |
| Alamo / Enterprise | 30 | 30 | 30 | 30 | 30 |
| Europcar | 34 | 41 | 41 | 40 | 41 |
| Hertz | 16 | 21 | 21 | 20 | 21 |

T+1'de GM filosunun yalnızca **%13'ü** listede; rakiplerde %88–100. Ayrıca 27–29 Ağustos'ta **economy kategorisi hiç yok** — en ucuz GM aracı 147,55 CHF.

### 2.6 Promosyon — 3 gün içinde son kullanma tarihi

Her GM teklifinde `appliedPromotions`: **%12 indirim, `bookingEndDate: 2026-08-29`**, finansman ≈ **%79 SUPPLIER + %21 TBU (Booking)**. Bu, listelenen tüm GM araçlarının %100'ünde üstü çizili fiyat + "% discount applied" rozeti sağlıyor. Rakiplerde: Budget %6–10, Avis %7–10, **diğer 9 tedarikçide 0**. Yenilenmezse görünen fiyat bir gecede **+%13,6** ve rozet kayboluyor.

### 2.7 Genç sürücü segmenti (yaş 22, 15.10 d3)

GM 96,32 → **162,05 (+%68)**, `AGED_DRIVER_FEE` 60 CHF (fiyata dahil). **Europcar 131,10 → 146,02 (+%11, ücret yok) ve #1'i alıyor.** GM #2'ye düşüyor. Ücretler: Unirent 59,70 · GM 60 · Dollar/Thrifty/Hertz 60,03 · Flizzr/Sixt 61,34 · Alamo/Enterprise 64,48 · Budget/Avis 72 · **Europcar 0**.

---

## 3. (a) Öncelikli 12 aksiyon

### P0 — Bu hafta

**1. 17 Kasım 2026 – 31 Aralık 2026 fiyat duvarını kaldır**
*Kanıt:* §2.4. GM 45 gün boyunca rank 80–194. Top-3 için gereken faktör 0,23–0,44.
*Beklenen etki:* **Çok yüksek.** 45 alış günü × 4 süre segmenti fiilen sıfır satıştan piyasa #1–3'e döner. 26.08–16.11 penceresindeki d3 performansı (rank 1) baz alınırsa bu, yıllık satılabilir gün sayısını %23'ten ~%35'e çıkarır.
*Efor:* **Düşük** — FMX kural yazımı (konsol zaten yapıyor).
*Ölçüm:* Her gün için `gmRank ≤ 3` ve kategori faktörü 0,97–1,05 bandında. Konsolda 17.11–31.12 için günlük rank grafiği; hedef: 45 günün ≥40'ında rank ≤3.
*Not:* Bu bilinçli bir stop-sale ise (kış lastiği / filo kısıtı), doğru çözüm fiyat duvarı değil **listeden çekmek** — çünkü rank 194'te görünen 415 CHF, marka algısını ve Recommended CTR'ını aşağı çekiyor.

**2. 2027 tarifelerini ve müsaitliğini yükle**
*Kanıt:* §2.4 — 05.01, 10.01, 16.01 (d1/d3/d7/d14), 13.02 (d1/d3/d7/d14), 15.03, 10.05 → **10/10 çekimde GM sıfır**, rakipler 158–219 araç.
*Beklenen etki:* **Çok yüksek.** İleri rezervasyon (kayak sezonu Ocak–Mart, yaz Mayıs+) tamamen kaçırılıyor. Rakipler bu tarihlerde 96–110 CHF/3g gibi düşük fiyatlardan satış yapıyor (Unirent 10.01: 96,28 CHF).
*Efor:* **Orta** — operasyonel/ticari (WheelSys/FMX rate loading, kontrat yenileme).
*Ölçüm:* Konsolda "kapsam %" metriği: sonraki 180 günün kaçında GM listeleniyor. Hedef ≥%95.

**3. %12 promosyonu 29 Ağustos'tan önce yenile**
*Kanıt:* §2.6. `bookingEndDate: 2026-08-29` — **3 gün kaldı.**
*Beklenen etki:* **Yüksek ve ani.** Yenilenmezse görünen fiyat +%13,6, üstü çizili "indirim" rozeti kaybolur, `deals=WITH_DEALS` filtresinden düşer (15.10 çekiminde bu filtre 243 aracın 53'ünü bırakıyor, 23'ü GM). d3'te top-3 faktörü 1,06 olduğundan +%13,6 zam GM'i lider konumdan düşürür.
*Efor:* **Çok düşük** — TBU/rentalcars extranet'ten kampanya uzatma.
*Ölçüm:* Konsol `appliedPromotions.promotionPercentage` ve `bookingEndDate` alanlarını izlesin; T-7'de uyarı maili.

### P1 — 2–4 hafta

**4. Süreye göre farklılaştırılmış fiyatlama**
*Kanıt:* §2.2. d1'de GM piyasanın %19–41 üzerinde (rank 9–33), d3'te %6–24 altında, d14'te %0–18 üzerinde.
*Beklenen etki:* **Yüksek.** d1: −%25/−%30 ile ekonomi/compact'ta rank 1–3'e girilir (ZRH'de d1 aramaları transit/iş yolcusu segmenti). d3: **+%5–6 zam, her kategoride top-3 korunarak** — 25 araç × 83 gün üzerinde doğrudan marj. d14: −%8.
*Efor:* **Orta** — FMX'te süre kırılımlı kural gerekiyor (konsolun `rule` body'si zaten `duration` taşıyor).
*Ölçüm:* Her (gün, süre) için faktör; hedef her sürede 0,97–1,05. Ayrıca ortalama günlük fiyat endeksi (piyasa=100): d1 141 → ≤100, d3 80 → 93–97.

**5. T+0…T+4 stok deliğini kapat**
*Kanıt:* §2.5. T+1'de 3 araç (%13), rakipler %88–100. 27–29.08'de economy kategorisi yok.
*Beklenen etki:* **Yüksek.** Son dakika aramaları hem yoğun hem yüksek marjlı; bugün GM en ucuz aracı 147,55 CHF ile giriyor (normalde 96).
*Efor:* **Orta** — allocation/stop-sale politikası, WheelSys müsaitlik senkronu.
*Ölçüm:* T+1…T+5 listeleme sayısı / T+30 listeleme sayısı ≥ %70 (bugün %13–61).

**6. Depozito ve hasar muafiyetini yeniden konumla**
*Kanıt:* §2.1. GM depozito 400 CHF, muafiyet 2500–3500. `depositAmountCategories` filtresinde **250_OR_BELOW kovası = 28 araç (yalnız Avis + Budget)** → GM dışarıda. `damageExcessCategories` ZRH'de tek kova (5000_OR_BELOW) olduğu için muafiyet filtre etkisi yok ama karar anında görünüyor; ayrıca 400 CHF depozito + 3000 CHF muafiyet, "value for money 7,5" ve iade şikâyetleriyle birleşince tezgâh riski algısı yaratıyor.
*Beklenen etki:* **Orta–yüksek.** 250 CHF'lik bir depozito ürünü GM'i Avis/Budget'ın tekelindeki en katı filtre kovasına sokar; muafiyeti <2500'e çekmek Alamo/Enterprise (1622–3243) seviyesine yaklaştırır.
*Efor:* **Düşük–orta** — ticari politika + rentalcars ürün tanımı güncellemesi.
*Ölçüm:* API'de `fees[DEPOSIT].price.amount` ve `depositBuckets` üyeliği; hedef BUCKET_1 (0–250).

**7. Online check-in / pre-registration'ı aç**
*Kanıt:* §2.1. Alamo 30/30, Enterprise 30/30, Hertz 21/21, Sixt 25/25, Budget 15/15, Avis 15/15 = **%100**; **GM 0/23**. `skipCounter` ZRH'de hiçbir tedarikçide yok — yani GM burada ilk olabilir.
*Beklenen etki:* **Orta.** Shuttle + tezgâh bekleme, GM'in en zayıf algı noktası; listede görünen bir "online check-in" rozeti bunu doğrudan hedefler. Ayrıca `collectTime` puanını (8,1) yukarı iter → `average` yukarı → 8+ filtresinde güvenlik payı.
*Efor:* **Orta** — rentalcars entegrasyon özelliği (tedarikçi tarafında etkinleştirme gerekir; **GM'e sunulup sunulmadığı doğrulanamadı**).
*Ölçüm:* `vehicle.preRegistrationSupported === true` oranı; `rating.collectTime` trendi.

### P2 — 1–3 ay (yapısal, en büyük kalıcı kaldıraç)

**8. "Value for money 7,5" ve tezgâh deneyimini düzelt**
*Kanıt:* §2.1 — GM en ucuz tedarikçi olmasına rağmen v4m'de 13 depo içinde sondan üçüncü; `cleanliness` 8,5 tüm havalimanı majörlerinin **altında** (Budget/Sixt 9,3; Dollar/Thrifty/Avis 9,1; Enterprise 9,0); `condition` 8,2. Dış kaynaklarda tekrar eden temalar: depozito iadesi gecikmeleri, küçük hasar için yüksek kesinti, tezgâhta agresif sigorta upsell'i, shuttle bekleme süresi ([Trustpilot greenmotion.ch](https://www.trustpilot.com/review/greenmotion.ch), [reviews.io](https://www.reviews.io/company-reviews/store/greenmotion-co-uk)).
*Beklenen etki:* **En yüksek kalıcı etki.** rentalcars'ın kendi ifadesiyle CTR ve rezervasyon sayısı Recommended sıralamasında büyük rol oynuyor — düşük dönüşüm zamanla fiyat avantajını eritir. 8,1 → 8,5 (Budget/Dollar seviyesi) hedefi.
*Efor:* **Yüksek** — süreç değişikliği: şeffaf hasar protokolü (teslim öncesi/sonrası fotoğraf), depozito iadesinde SLA, upsell yerine net paket, araç temizlik standardı.
*Ölçüm:* `rating.average`, `rating.valForMoney`, `rating.cleanliness`, `rating.condition` — haftalık; **eşik alarmı: average < 8,15** (8,0 altında `8_OR_ABOVE` filtresinden düşer; bu filtre 243 aracın 210'unu tutuyor).

**9. Yorum hacmini 390 → 1.500+ çıkar**
*Kanıt:* §2.1. GM 390 yorum; Alamo 4288, Europcar(CRC) 4702, Budget 3228, Unirent 2438, Enterprise 1886, Hertz 1672.
*Beklenen etki:* **Orta–yüksek.** Düşük hacim hem güven sinyalini zayıflatır hem tek bir kötü deneyimin ortalamayı 0,1–0,2 puan oynatmasına yol açar — 8,0 filtre uçurumuna 0,1 puan mesafedeyken bu ciddi bir risk.
*Efor:* **Orta** — iade sonrası anket hatırlatması, sadece rentalcars kanalı üzerinden gelen müşterileri hedefleyen post-rental iletişim.
*Ölçüm:* `rating.numRatings` aylık artışı; hedef +100/ay.

**10. 7 koltuk / minivan ve full_size boşluğunu doldur**
*Kanıt:* §2.3. Her çekimde mevcut ama GM'de sıfır: carriers 24,5 rakip araç (giriş ~196 CHF/3g), luxury 22,1 (257), full_size 12,8 (236), carriers_7 10,5 (249), carriers_9 7,6 (282). `seatCapacity` 6_TO_7 = 15 araç, 8_TO_9 = 12 araç → GM yok.
*Beklenen etki:* **Yüksek ama yavaş.** Aile/grup segmenti ZRH'de yapısal talep; ayrıca yüksek ortalama sepet (379 CHF vs 122 CHF "small" grubu).
*Efor:* **Yüksek** — filo yatırımı. Minimum uygulanabilir adım: 2 adet 7 koltuk (carriers_7) + 1 full_size.
*Ölçüm:* `aggregates.carCategories` içinde GM'in temsil edildiği kategori sayısı (bugün 7/16); `seatCapacity` 6_TO_7'de GM varlığı.

**11. 2–3 EV/hybrid ekle**
*Kanıt:* §2.1/§2.3. GM'de **0** elektrikli/hibrit; Europcar 9, Sixt 3, Hertz 2, Dollar/Thrifty/Budget/Avis/Unirent 1'er. `fuelTypes` filtresi: Electric = 19 araç, priceFrom 110,59. GM'in kendi markası "Green Motion" olmasına rağmen bu filtrede görünmüyor.
*Beklenen etki:* **Orta.** Hem bir filtre kovasına giriş hem marka tutarlılığı; ZRH'de EV giriş fiyatı 110,59 CHF, GM'in maliyet yapısıyla altına inilebilir → yeni bir "#1" pozisyonu.
*Efor:* **Orta.**
*Ölçüm:* `fuelTypes=Electric` filtresinde GM rank'i.

**12. Genç sürücü ücreti + shuttle şeffaflığı**
*Kanıt:* §2.7 (yaş 22'de GM +%68 vs Europcar +%11 → GM #1'i kaybediyor) ve §2.1 (GM ZRH'de tek SHUTTLE_BUS tedarikçisi; adres Howiesenstrasse 36, Rümlang 8153 — rakipler Rondellstrasse/Kloten terminal alanında).
*Beklenen etki:* **Düşük–orta.** Ekonomi/compact'ta 25 yaş altı ücretini 60 → 30 CHF'ye çekmek, yaş 22 aramalarında GM'i tekrar #1 yapar (162,05 → ~132, Europcar 146,02'nin altı). Shuttle tarafında: sabit 10 dk sefer sıklığı taahhüdü + depoda net yönlendirme, `collectTime` ve `locating` puanlarını hedefler.
*Efor:* **Düşük** (ücret) / **Orta** (shuttle operasyonu).
*Ölçüm:* Yaş 22 probe'unda GM rank'i; `rating.collectTime` ve `rating.locating` trendi.

---

## 4. (b) Konsolun ek olarak izlemesi / otomatikleştirmesi gerekenler

**Kapsam ayarları (mevcut `AUTOSCAN` yetersiz):**
1. **`monthsAhead: 2` → 6.** Bugün (26.08) 2 ay ufku 31 Ekim'de bitiyor; **17 Kasım fiyat duvarı ve 1 Ocak yokluğu tarama ufkunun tamamen dışında.** Kademeli örnekleme öner: ilk 45 gün günlük, 45–120 gün 3 günde bir, 120–180 gün haftalık — böylece `freshBudget` patlamaz.
2. **`durations: [3]` → `[1, 3, 7, 14]`.** Veri, aynı günde faktörün d1 için 0,63, d3 için 1,00 çıkabildiğini gösteriyor; tek süre üzerinden kural yazmak diğer üç segmenti kör bırakıyor.

**Yeni sinyaller (hepsi mevcut API payload'ında var, `lib/rc.js` bugün parse etmiyor):**

3. **"GM listelenmiyor" birinci sınıf alarm.** Motor bugün GM olmayan günleri sessizce atlıyor (`skip when GM not listed`). En büyük problem tam olarak bu. Metrik: *"sonraki N günün %X'inde GM listeleniyor"*; %95 altına düşünce mail.
4. **Filo genişliği zaman serisi** — `gmOffers.length` gün bazında. Alarm: 30 günlük medyanın %50'sinin altına düşüldüğünde (T+1'deki 3 araç bunu yakalardı).
5. **Promosyon takibi** — `appliedPromotions[0].promotionPercentage`, `bookingEndDate`, `promotionBreakdown[].fundingEntity` (SUPPLIER vs TBU payı). **T-7'de son kullanma uyarısı.** Ayrıca rakip promosyon derinliği (Budget %6–10, Avis %7–10) → "rakip indirimi bizimkini geçti" alarmı.
6. **Gerçek Recommended rank.** `filterCriteria` göndermeden ikinci bir çağrı yapıp `recommendedDisplayOrder` kaydet. Müşterinin gördüğü sıra bu; konsolun bugün ölçtüğü fiyat rank'i değil. Ek metrik: **top-20 içindeki GM payı** (bugün 6/20).
7. **Puan izleme** — `rating.{average, numRatings, valForMoney, cleanliness, condition, collectTime}`. **Eşik alarmı: `average < 8.15`** (8,0 = `8_OR_ABOVE` filtre uçurumu). `numRatings` artış hızı da KPI.
8. **Kategori/koltuk/yakıt kapsama açığı** — `aggregates.carCategories`, `seatCapacity`, `fuelTypes` üzerinden "GM'in 0 teklifi olduğu kovalar + oradaki rakip araç sayısı + giriş fiyatı". Fiyat kararı değil ama filo kararı için tek gerçek veri kaynağı.
9. **Depozito/muafiyet kova üyeliği** — `depositBuckets` / `depositAmountCategories` içinde GM hangi kovada. "250_OR_BELOW dışındayız" kalıcı bir uyarı satırı olmalı.
10. **Yaş segmenti probe'u** — günde bir kez `driversAge: 22` ile tek çağrı; GM rank'i ve `AGED_DRIVER_FEE` kaydı. Bugün konsol bu segmente tamamen kör.
11. **`sponsoredSlot.sponsoredVehicle` sayacı** — ZRH'de ücretli slot belirdiği an haber vermeli (şu an 0).
12. **Konum tipi payı** — `depotLocationTypes` içindeki SHUTTLE_BUS araç sayısı = GM araç sayısı olduğu sürece "tek shuttle tedarikçisiyiz" riski açık kalır; başka bir shuttle tedarikçisi girerse fiyat tabanı değişir.

**Otomasyon / güvenlik:**

13. **Sanity guardrail (en önemlisi).** Kural yazmadan önce ve tarama sırasında: hesaplanan faktör **< 0,50 veya > 1,50** ise kuralı otomatik uygulama, kırmızı alarm at. 17 Kasım duvarı (faktör 0,44) ve 1 Aralık duvarı (0,23) bu kontrolle anında yakalanırdı.
14. **Gün-üstü sıçrama alarmı.** Ardışık iki alış günü arasında GM merdiveninin **%40'tan fazla** kaymasını raporla (16.11 → 17.11 = %145 sıçrama).
15. **Kalıcı zaman serisi.** Bugün her şey 6 saatlik cache; geçmiş yok. Günlük snapshot (fiyat, price-rank, recommended-rank, filo sayısı, puan, promosyon) Firestore'a yazılmalı — aksi hâlde hiçbir kural değişikliğinin **öncesi/sonrası** ölçülemez ve bu raporun aksiyonları doğrulanamaz.
16. **Alış saati çeşitliliği.** Konsol 19:00'a sabit; sabah 09:00 alışları (iş yolcusu) ayrı bir rekabet tablosu üretiyor olabilir — en az haftada bir kontrol probe'u.
17. **`freshBudget` bütçesini kapsamla ölçekle.** 6 aylık ufuk × 2 istasyon × 4 süre ≈ 1.400+ hücre; 40 sorgu/saat ile tam tur ~35 saat. Rotating cursor zaten var ama kritik pencereyi (T+0…T+45) her turda tarayan bir "hot band" ayrılmalı.

---

## 5. (c) Doğrulanamayanlar (açık liste)

1. **Dönüşüm verisi yok.** Payload'daki `numBookings` her satırda 0; impression/click/booking telemetrisi bu API'den alınamıyor. Bu rapordaki "dönüşüm" ifadelerinin tamamı **çıkarım**, ölçüm değil. Gerçek doğrulama ancak rentalcars tedarikçi extranet'i veya WheelSys rezervasyon verisiyle mümkün.
2. **17 Kasım fiyat duvarı ve 2027 yokluğu kasıtlı mı?** Kış lastiği politikası, filo stop-sale'i, kontrat/tarife bitişi olabilir; FMX ve WheelSys tarafına bakmadım (brief gereği repo salt-okunur ve bu sistemlere erişimim yok). **Aksiyon 1 ve 2'yi uygulamadan önce bu mutlaka teyit edilmeli.**
3. **Recommended algoritmasının GM için gerçek ağırlıkları.** rentalcars "price, ratings, size, profit, car specs and more" diyor; komisyon/profit'in GM özelinde ne kadar ağırlık taşıdığı yayınlanmıyor.
4. **Sponsorlu yerleşim satın alınabilir mi?** İncelenen ~4.000 satırın hepsinde `sponsoredVehicle:false`. ZRH'de böyle bir ürünün var olup olmadığı, fiyatı ve GM'e açık olup olmadığı doğrulanamadı.
5. **`preRegistrationSupported` GM'e sunuluyor mu?** Alanın var olduğunu ve 6 rakipte true olduğunu gördüm; GM'in bunu etkinleştirebilmesi için teknik/ticari şartın ne olduğu bilinmiyor.
6. **Saat içi fiyat oynaklığı.** 10.09 d3 için aynı sorgu ~1 saat içinde GM Clio'yu 98,63 → 101,62 → 115,48 CHF (+%17) döndürdü; aynı pencerede Unirent +%2,5, Alamo +%1. GM'e özgü olması bir FMX kural yazımını (aynı sprint'te başka bir agent'ın deploy'u olabilir) veya tedarikçi tarafı yield'ı düşündürüyor — **nedeni belirlenemedi.** Konsolun zaman serisi (öneri 15) bunu ayrıştırır.
7. **Puanlama penceresi ve toplulaştırma.** Kaç aylık yorumun ortalamaya girdiği, puanın depo bazlı mı marka bazlı mı hesaplandığı, minimum yorum eşiği yayınlanmıyor. (Europcar'ın iki deposunun 8,8/4702 ve 8,2/154 olması **depo bazlı** olduğunu güçlü şekilde gösteriyor, ama resmî teyit yok.)
8. **Coğrafya/cihaz farkı.** Tüm çekimlerde `visitorCriteria.countryOfResidence: "CH"`. DE/UK/US ikametli kullanıcı, mobil uygulama, Booking Genius seviyesi veya login'li oturum için fiyat/sıralama farkı **test edilemedi** (IP tabanlı, bu makineden değiştirilemiyor).
9. **Maliyet ve marj verisi yok.** "d3'te +%5–6 zam" önerisi yalnızca gelir tarafı; fiyat esnekliği ölçülmedi. A/B testi olmadan zam sonrası hacim kaybı bilinemez — bu yüzden önerim kademeli (+%3, ölçüm, +%3).
10. **Şehir içi depo.** Zürih merkez (LATLONG) araması havalimanı depolarını döndürüyor; GM'in gerçek bir şehir deposu yok (Flizzr'ın var). Açılabilir mi / ticari olarak anlamlı mı, değerlendirilemedi.
11. **Rakip promosyonlarının süresi.** Budget/Avis promosyonlarının `bookingEndDate`'i de 2026-08-29 görünüyor; bunun platform geneli bir kampanya penceresi mi yoksa tedarikçi bazlı mı olduğu ayrıştırılamadı.

---

**Kaynaklar:**
- [rentalcars.com — How we Work](https://www.rentalcars.com/en/how-we-work)
- [Booking.com — How we work](https://www.booking.com/content/how_we_work.html)
- [Which? — Booking.com/Rentalcars.com car hire review](https://www.which.co.uk/reviews/car-hire/article/car-hire-broker-reviews/rental-cars-aFOip5i7Xoc8)
- [Trustpilot — Green Motion SA (greenmotion.ch)](https://www.trustpilot.com/review/greenmotion.ch)
- [reviews.io — Green Motion UK](https://www.reviews.io/company-reviews/store/greenmotion-co-uk)
- [Green Motion — Zurich Airport lokasyonu](https://greenmotion.com/locations/switzerland/zurich-airport)
- Canlı veri: `https://www.rentalcars.com/api/search-results` (68 çağrı, 26.08.2026); ham JSON ve analiz script'leri `/private/tmp/claude-501/-Users-berkaybuyukdere-PRICINGSENTINEL/dba47f2e-8d86-4c96-a2e6-eeea3c1be635/scratchpad/rc/` ve `.../scratchpad/an1.js…an8.js`