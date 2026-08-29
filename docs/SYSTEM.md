# GM Pricing Console — Sistem Dokümantasyonu

Green Motion Zürih'in FuseMetrix Dynamic Pricing System (FMX DPS) üzerindeki
haftalık fiyat kurallarını hızlı yönetmek ve rentalcars.com pazarını canlı
izlemek için geliştirilmiş yerel web paneli.

## 1. Mimari

```
Tarayıcı (localhost:4646)
   │  Palantir tarzı SPA — public/index.html + app.js + style.css
   │  Firebase Auth (e-posta/parola) → idToken → operatör çerezi  (bkz. §2)
   ▼
Node.js / Express (server.js)
   │  ├─ firebase-admin → verifyIdToken, users/<uid> (rol, tenant)
   │  ├─ lib/fmx.js  → <tenant.fmxBase>  (FMX oturumu, kural CRUD)
   │  └─ rcQuery     → rentalcars.com/api/search-results  (pazar verisi)
   ▼
Yerel durum dosyaları (.gitignore'da):
   .session            FMX oturum çerezi
   .secrets.json       SMTP ayarları (şifre dahil — asla commit edilmez)
   .cache-details.json FMX kural detay önbelleği (ruleid + Date Updated)
   .rc-cache.json      rentalcars cevap önbelleği (gün+süre başına)
   .rc-watch.json      Market Watch temel çizgisi (baseline)
   .tenants.json       Franchise/istasyon kaydı (bkz. §4)
   .logs.json          Aktivite logu (kim/ne zaman/ne idi→ne oldu)
   .backups/           Geri dönüş noktaları (tüm kuralların anlık görüntüsü)
```

## 2. Kimlik doğrulama ve roller

Panelin kapısı **Firebase Auth**'tur (Identity Platform, `sentinelpricing`
projesi, e-posta/parola sağlayıcısı). Konsol açılmadan önce tam ekran
`#authGate` gelir; FMX girişi ikinci adıma iner.

```
Tarayıcı                              Sunucu
 signInWithEmailAndPassword
        │ idToken
        ▼
 POST /api/auth/session  ─────────►  admin.auth().verifyIdToken(idToken)
                                     rol = custom claim `role`
                                       ↳ yoksa users/<uid>.role
                                       ↳ o da yoksa 'staff'
        ◄─────────────────────────  __session çerezi {u, uid, role, exp, g}
        │
        ▼
 init() → konsol açılır
        │  FMX oturumu yoksa
        ▼
 POST /api/login  (FMX kullanıcı/parola)      ← ikinci adım
```

- **Operatör çerezi değişmedi**: aynı HMAC imzalı `__session` token'ı, artık
  içinde `uid` ve `role` de taşıyor. Eski çerezler geçerliliğini korur —
  `uid`/`role` yoksa rol `staff` sayılır.
- `/api` middleware'i çerezi istemeye devam eder ve `req.operator =
  {u, uid, role}` kurar. Muaf uçlar yalnızca `GET /api/session` ve
  `POST /api/auth/session`'dır; **`/api/login` artık muaf değil** — yani önce
  Firebase, sonra FuseMetrix. FMX girişi konsolun kapısı değil, FMX oturumunu
  bağlayan ikinci adımdır.
- **Roller tam olarak iki tanedir**: `admin` ve `staff`. Admin'e özel uçlar
  (`PUT /api/stations`) `requireAdmin` ile korunur ve 403 `FORBIDDEN` döner.
  Arayüz de admin'e özel kartları staff için gizler ya da salt-okunur gösterir.
- `GET /api/session` ve `GET /api/stations` cevaplarında `role` döner
  (`/api/session` ayrıca `email`); sol alttaki kullanıcı bloğundaki ve
  Settings'teki rol rozeti buradan beslenir.
- **Token tazeleme**: istemci 50 dakikada bir `getIdToken(true)` ile ID
  token'ı yeniler ve `/api/auth/session`'ı tekrar çağırır; böylece operatör
  çerezi Firebase oturumundan uzun yaşamaz. `onAuthStateChanged` çıkışta
  kapıyı geri getirir. SIGN OUT hem `firebase.auth().signOut()` hem
  `POST /api/logout` çalıştırır.
- **Kullanıcı kaydı**: Firestore `users/<uid>` → `{email, role, displayName,
  createdAt, tenant}`. Rol mümkünse custom claim olarak da yazılır (claim
  varsa Firestore okuması yapılmaz).
- Tek cihaz kuralı (§15, authGen) FMX oturumu için aynen geçerlidir.

## 3. Kullanıcı yönetimi ve roller

Operatörler artık konsolun içinden açılır — Firebase konsoluna girmeye gerek
yok. Sol menüdeki **USERS** görünümü (`#view-users`) yalnız `admin` rolüne
görünür; staff için menü öğesiyle birlikte tamamen gizlenir.

| Uç | İş |
|---|---|
| `GET /api/users` | çağıranın tenant'ındaki kullanıcılar |
| `POST /api/users` | yeni kullanıcı: Firebase Auth + `{role}` claim + `users/<uid>` |
| `PATCH /api/users/:uid` | `role` / `disabled` / `displayName` / `tenant` |
| `DELETE /api/users/:uid` | auth kullanıcısı **ve** Firestore dokümanı |

- **Dördü de `requireAdmin` arkasındadır ve rol yalnızca sunucunun imzaladığı
  `__session` çerezinden okunur.** İstek gövdesindeki hiçbir alan (`role`,
  `tenant`, `uid` …) yetki belirlemez; gövdeden gelen rol yalnız *hedef*
  kullanıcının rolü olabilir, çağıranın değil.
- Satır şekli: `{uid, email, displayName, role, tenant, disabled, createdAt,
  lastSignIn}`. Liste Firestore `users` koleksiyonundan **tenant'a göre
  süzülerek** okunur, `admin.auth().getUser` ile zenginleştirilir.
- **Tenant kapsamı**: bir admin yalnız kendi franchise'ının kullanıcılarını
  listeler, oluşturur, değiştirir ve siler. Yeni kullanıcının `tenant`
  alanı belirtilmezse çağıranınki uygulanır.
- **Superadmin istisnası**: `users/<uid>.superadmin === true` olan operatör
  bütün tenant'ların kullanıcılarını görür ve `tenant` alanını serbestçe
  atayabilir. Tohum uid `p7r1tSFsvuTcsc22MGruMjH6wh53` için bu alan eksikse
  boot sırasında yazılır.
- **Kendini kilitleme koruması**: çağıran kendi rolünü düşüremez, kendini
  devre dışı bırakamaz ve kendi hesabını silemez — 400 `SELF_LOCKOUT`.
- **Parola** en az 8 karakter olmalıdır ve hiçbir yerde geri dönmez: ne HTTP
  cevabında, ne activity log'unda, ne de sunucu çıktısında.
- **Arayüz**: `.usr-table` — e-posta, ad, rol rozeti
  (`.usr-role` + `.role-admin` / `.role-staff`), durum ve son giriş sütunları.
  Satır işlemleri (rol değiştir, aç/kapat, sil) `confirmBox` onayından geçer;
  çağıranın kendi satırı `.usr-self` ile işaretlidir. Kartın altındaki
  **CREATE USER** formu e-posta, parola, ad ve rol alır. 375px'te tablo tüm
  sütunlarıyla kendi kutusunda yatay kayar, sayfa gövdesi kaymaz.
- `GET /api/stations` cevabı `role` yanında **`superadmin: true|false`** de
  taşır; istemci `state.role` / `state.superadmin` ile admin'e özel yüzeyleri
  açar: USERS görünümü, Settings'teki FRANCHISES kartı ve artık
  **RC RELAY MACHINES kartı** (bu kart staff'a gizlenir; topbar'daki relay
  chip'i herkeste kalır).

## 4. Çoklu franchise: tenant ve istasyonlar

İstasyonlar artık `server.js` içinde sabit değil; **tenant kaydından** okunur.
Böylece aynı konsol birden çok Green Motion franchise'ına hizmet edebilir.

- Kalıcı `tenants` store anahtarı (bulutta Firestore, yerelde JSON dosyası):

  ```
  { "<tenantId>": {
      name, fmxBase,
      stations: [ { id, name, rc: { type: 'IATA' | 'LATLONG', loc, label } } ]
  } }
  ```

- İlk açılışta mevcut sabit değerlerle **tohumlanır** (`gmzurich` /
  "Green Motion Zürich" / `https://zrh.dps.greenmotion.com`; 61489 Zurich
  Airport → IATA `ZRH`, 61551 Zurich Downtown → LATLONG
  `47.37798309326172,8.539767265319824`), yani hiçbir davranış gerilemez.
- Operatörün tenant'ı `users/<uid>.tenant`'tan gelir (varsayılan `gmzurich`).
  `GET /api/stations` artık `{stations, durations, tenant:{id,name}, role}`
  döner; topbar'daki tenant chip'i ve istasyon sekmelerinin altındaki
  rentalcars konum etiketi bundan çizilir.
- `rcUrl(args)` istasyonun rc yapılandırmasını parametre olarak alır (sabit
  tablo yok); yalnız `station` geçen eski çağrılar aktif tenant üzerinden
  çözülür.
- **Havalimanı / konum seçici**: `GET /api/places?q=` rentalcars'ın
  `FTSAutocomplete.do` ucunu proxy'ler (rcQuery ile aynı yol: önce doğrudan
  fetch, bulutta engellenirse relay). Cevaptaki `placeType` `A` ise
  havalimanı — `{type:'IATA', loc:<iata>}`; diğer her şey
  `{type:'LATLONG', loc:'<lat>,<lng>'}` olur. En çok 8 sonuç döner,
  havalimanları ✈ işaretiyle listelenir.
- **Settings → STATIONS kartı** (yalnız admin): satır başına `id`, düzenlenebilir
  `name`, güncel rentalcars konumu ve seçici; satır ekle/çıkar; SAVE →
  `PUT /api/stations`. Sunucu doğrular (id pozitif tam sayı, ad 1–60 karakter,
  `rc.type` iki değerden biri, IATA `^[A-Z]{3}$`, LATLONG
  `^-?\d+(\.\d+)?,-?\d+(\.\d+)?$`), değişikliği activity log'a yazar ve
  değişen/silinen istasyonların rc önbelleğini düşürür. Staff aynı kartı
  salt-okunur, açıklama notuyla görür.

## 5. Franchise (tenant) yönetimi

§4'teki tenant kaydı artık konsoldan yönetilir — Settings → **FRANCHISES**
kartı (`.fr-list`, satır başına ad + id + istasyon chip'leri + sayaçlar).

| Uç | Kim |
|---|---|
| `GET /api/tenants` | admin (superadmin: hepsi, normal admin: yalnız kendisi) |
| `POST /api/tenants` | **yalnız superadmin** |
| `PATCH /api/tenants/:id` | superadmin her tenant; admin yalnız kendi tenant'ının `name` + `stations` alanları |

- Cevap satırı `{id, name, fmxBase, stationCount, userCount}`.
- Yeni franchise id'si `^[a-z0-9-]{2,32}$` kalıbına uymalı ve **benzersiz**
  olmalıdır. `stations` dizisi `PUT /api/stations` ile **birebir aynı**
  doğrulamadan geçer (id pozitif tam sayı, ad 1–60 karakter, `rc.type` iki
  değerden biri, IATA `^[A-Z]{3}$`, LATLONG `^-?\d+(\.\d+)?,-?\d+(\.\d+)?$`)
  — yani bir franchise, kullanacağı havalimanlarıyla **birlikte** kurulur.
- Formdaki havalimanı seçici §4'teki `GET /api/places?q=` bileşeninin
  aynısıdır (`.st-pick` + `.place-drop`); birden çok istasyon eklenebilir.
- **Kullanıcısı olan bir tenant silinemez** — önce kullanıcıları taşımak ya da
  silmek gerekir (§3).
- Normal admin kartta yalnız kendi franchise'ını görür ve düzenler; CREATE
  FRANCHISE formu yalnız superadmin'e açılır. Çağıranın kendi franchise'ı
  `.fr-own` ile vurgulanır.

## 6. FMX entegrasyonu (API yok — form protokolü)

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

## 7. Fiyatların rentalcars'a akışı (pull modeli)

FMX'te Save yalnızca veritabanını günceller; hiçbir push yoktur. Rentalcars,
Green Motion'ın XML fiyat motoruna (bespoke/price_engine) kendi sorgusunu
attığında yeni fiyat hesaplanır: Taban fiyat → günlük Price Override →
eşleşen kurallar (senin yüzdenler) → XML cevap. Rentalcars kendi teklif
önbelleğini tazeleyene kadar (dakikalar) sitede eski fiyat görünebilir —
bkz. §14 Canlı Senkron.

## 8. Panel sayfaları

- **DASHBOARD** (açılış): stat tile'ları (bugünkü GM sırası, pazar lideri,
  Market Watch durumu, restore point sayısı), istasyon kartları (ortalama /
  min–maks / kapsama çubuğu), **RC MARKET RANK** şeridi (ayın her günü için
  GM'in sırası, 6 saat önbellekli akış), fiyat eğrisi, restore points,
  Market Watch kartı (otomatik tarama durumu ve bekleyen öneriyi tek tıkla
  uygulama düğmesi de burada — bkz. §12), son aktiviteler.
- **PRICING GRID**: üstte istasyon sekmeleri (her sekmenin altında o
  istasyonun rentalcars konum etiketi — bkz. §4), altında gün × süre
  (2/3/4/5/6+) matrisi. Hücreye yaz → staged →
  APPLY. Sütun/satır doldurma, COPY → (ayı başka aya kopyala), TOP-10 SWEEP,
  **SCAN** (görünen ayın tamamı için top-10 kalabalıklaştırma — bkz. §10),
  **WEEKLY RULES** (aylara yayılan toplu kural üretimi — bkz. §9),
  vendor seçici, kapsanmayan gün uyarıları, ⌕ analiz butonu, sağ tık →
  rentalcars karşılaştırma (en düşük fiyat sıralı, saat rotasyonu
  19:00→16:00). Kuralı yalnız bazı araç gruplarını hedefleyen hücreler
  `.cell-partial` kaması taşır; ipucu kapsamı (`3/39: ZU-A, ZU-B, ZU-C` ya da
  `ALL GROUPS`) yazar — bkz. §9.
- **USERS** (yalnız admin): tenant'ın kullanıcı tablosu — e-posta, ad, rol
  rozeti, durum, son giriş; satır işlemleri ve CREATE USER formu. Staff'ta
  menü öğesiyle birlikte tamamen gizlidir — bkz. §3.
- **ANALYTICS**: büyük fiyat eğrisi (renk körlüğü doğrulanmış 5 seri palet,
  TODAY işareti, hover crosshair+nokta) + süre bazlı avg/min/max.
- **ACTIVITY**: tam log — zaman, kullanıcı, istasyon, hedef tarih/süre,
  işlem, eski→yeni değer, durum; her satırda **REVERT**. SCAN gibi toplu
  işlemlerin aynı batch'e ait ardışık kayıtları tek satırda toplanır
  (⌖ · "SCAN SWEEP · N CHANGES", ok/fail sayaçları) ve **REVERT ALL** tek
  onayla tüm batch'i geri alır (RC önbelleği + grid tazelenir).
- **SETTINGS**: hesap kartı (kullanıcı, rol rozeti, FMX oturum durumu, çıkış),
  **STATIONS** kartı (istasyon adı + havalimanı/konum seçici; yazma yetkisi
  yalnız admin'de, staff salt-okunur görür — bkz. §4), **FRANCHISES** kartı
  (yalnız admin; superadmin'de CREATE FRANCHISE formu — bkz. §5),
  **RC RELAY MACHINES** kartı (artık yalnız admin; topbar relay chip'i
  herkeste), ALERT MAIL adresi ve **REPORT MAILS** anahtarı (herkes — bkz.
  §13), tema, HUD ölçeği (60–130 kaydırıcı), arayüz dili (İngilizce / Almanca
  / Türkçe, localStorage'da saklanır) ve sistem durumu (ortam, RC relay, mail,
  temel). Sol alttaki kullanıcı bloğu da bu sayfaya götürür.

**Mobil düzen**: dar ekranlarda (≤780px) sol kenar çubuğu 5 ikonlu **alt sekme
çubuğuna** dönüşür (başparmakla erişilir, sabit); topbar chip/butonları sarar,
marka ve tenant chip'i kalır. Kartlar/stat satırları/ayarlar tek sütuna iner, küçük tile'lar
2'li kalır. Grid ay×süre matrisi kendi kutusunda **yatay kaydırılır** (gün
sütunu yapışkan), sayfa gövdesi asla yana kaymaz. Modallar (RC, sweep, oturum)
küçük kenar boşluğuyla tam genişlik açılır, içeride kaydırılır; RC kategori ve
süre chip'leri 375px'te sararak kullanılabilir kalır; dokunma hedefleri ≥40px.
Giriş kapısı (`#authGate`) telefonda tam genişlik karta iner; STATIONS kartında
her istasyon satırı (id + ad, konum seçici, işlemler) alt alta yığılır ve
sekmelerin konum etiketi gizlenir. USERS tablosu sütunlarını korur ve **kendi
kutusunda** yatay kayar (e-posta sütunu genişliğin üçte birini alır); franchise
satırları ile CREATE USER / CREATE FRANCHISE formları tek sütuna iner; WEEKLY
RULES modalı diğer modallar gibi tam genişliğe geçer, araç grubu listesi
kısalır ve chip'leri ≥40px dokunma hedefine büyür. Masaüstü düzeni 780px
üstünde değişmez.

**İptal onayları**: çalışan çok adımlı bir işlemi kapatmak/iptal etmek "emin
misin?" onayı ister (confirmBox) — SCAN sürerken durdurma, TOP-10 SWEEP
modalını sweep koşarken kapatma, dolu grid değişikliklerini DISCARD ile silme,
ve staged bir yerleştirme/projeksiyon varken RC modalını kapatma. Döngüler
iptal bayrağını her adımda kontrol eder, temiz durup durumu sıfırlar ve
"iptal edildi" bilgisi verir. APPLY döngüsü zaten kendi onayını sorar.

## 9. Toplu weekly rules oluşturma

Grid kontrollerindeki **WEEKLY RULES** düğmesi (`#bulkBtn`) tek işlemde
aylara yayılan bir kural seti üretir: bir başlangıç tarihinden itibaren N
takvim günü × seçili süreler.

### Modal (`#bulkModal`)

START DATE (gerçek `date` girdisi, varsayılan bugün) · **HORIZON**
30 / 60 / 90 / 120 / 180 gün chip'leri · **DURATIONS** (mevcut süre chip'leri,
çoklu seçim) · **PERCENT** · **VEHICLE GROUPS** (aşağıya bakınız) ·
**SKIP EXISTING** anahtarı (varsayılan açık). Üstte canlı bir önizleme satırı
durur: `En çok N kural — 2026-08-27 → 2026-11-24`.

### Tarih yürüyüşü tam olarak doğrudur

`days`, **başlangıç günü dahil** takvim günü sayısıdır (30 → startDate + 29).
Hem sunucu hem istemci aynı **UTC-güvenli** yürüyüşü kullanır:

```js
const [y, m, d] = startDate.split('-').map(Number);
for (let n = 0; n < days; n++) {
  const t = new Date(Date.UTC(y, m - 1, d + n));      // taşma takvimce çözülür
  const iso = t.getUTCFullYear() + '-' +
              pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate());
}
```

- `Date.UTC` gün taşmasını takvimin kendi kurallarıyla çözer: ay uzunlukları
  (28/29/30/31) ve artık yıllar elle hesaplanmaz, dolayısıyla yanlış olamaz.
- Okuma `getUTCFullYear/Month/Date` ile yapılır — yerel saat dilimi ve
  **yaz saati geçişleri** tarihi bir gün kaydıramaz (`toISOString` üzerinden
  yerel bir `Date` okumanın klasik hatası budur).
- İstemcideki önizleme ile sunucunun ürettiği gün listesi **birebir aynı
  algoritmadır**; "N kural, şu tarihe kadar" cümlesi ile gerçekte yazılan
  kurallar hiçbir ayda ayrışmaz.

### Doğrulama (`POST /api/rules/bulk`)

Gövde: `{station, startDate, days, durations, pct, vehicleIds?, vendors?,
skipExisting}`.

- `station` **çağıranın tenant'ına ait olmalıdır** (aksi hâlde reddedilir),
- `days` ∈ {30, 60, 90, 120, 180}, `durations` `DURATIONS`'ın boş olmayan bir
  alt kümesi, `pct` sonlu ve [−95, 100] aralığında,
- `startDate` **gerçek bir takvim günü** olmalı (`2026-02-30` reddedilir —
  UTC'de geri okunan gün girdiyle aynı değilse tarih yoktur) ve bugünden en
  çok 24 ay ileride olabilir.

### Arka plan işi ve ilerleme

Uzun tek bir istek yoktur (`maxInstances:1` altında bloklardı):

- `POST /api/rules/bulk` hemen `{jobId}` döner,
- `GET /api/rules/bulk/:jobId` → `{status:'running'|'done'|'failed', done,
  total, ok, fail, batch, error}` — istemci 1,5 saniyede bir yoklar ve
  `.bulk-prog` / `.bulk-bar` ilerleme çubuğunu çizer,
- `POST /api/rules/bulk/:jobId/cancel` çalışan işi durdurur (confirmBox'lu
  CANCEL düğmesi),
- işler bellekte tutulur, son 5 tanesi saklanır.

Her gün × süre için: `skipExisting` açıkken grid'e uyan bir kural zaten varsa
ve çakışan (CONFLICT) hücrelerde **atlanır**; kalanlar mevcut **doğrulamalı
yazma** yolundan geçer. Tüm kayıtlar ortak bir `batch` kimliği ve
`batchTag:'bulk'` ile loglanır — ACTIVITY bunları tek satırda toplar
(`batch_bulk_label`) ve **REVERT ALL** hepsini tek onayla geri alır. İş
bitince dokunulan günlerin RC önbelleği düşürülür.

### Araç grupları (vehicle groups)

- FMX'in kural formundaki 39 araç grubu artık isimleriyle bilinir:
  `GET /api/vehicle-groups` → `{groups:[{id:'102185', code:'ZU-A'}, …]}`.
  Kodlar formdaki `rel` niteliğinden okunur, `999999` "(select all)" sahte
  girdisi ayıklanır; liste `lib/fmx.js` içinde önbelleklenir ve FMX çerezi
  değişince (`setCookie`) düşer.
- `POST /api/rule` ve `PUT /api/rule/:id` isteğe bağlı `vehicleIds: string[]`
  kabul eder; her giriş bilinen bir grup id'si olmalıdır. **Boş ya da yok →
  bütün gruplar** (bugünkü davranış aynen korunur). Seçilen grup sayısı
  activity log'una `groups: <n|'ALL'>` olarak yazılır.
- Grid akışındaki hücreler `groups: <count>` ve `groupIds: <string[]>` taşır;
  istemci bunu hücre ipucunda `3/39: ZU-A, ZU-B, ZU-C` ya da `ALL GROUPS`
  olarak gösterir ve alt kümeyi hedefleyen hücreleri **`.cell-partial`** ile
  işaretler (sağ alt köşede küçük mavi kama — köşenin diğer üç yanı OFF/DEL
  ve op uyuşmazlığı işaretlerine ayrılmıştır).
- Modaldeki `.vg-list` çoklu seçim listesi ALL / NONE kısayolları ve canlı
  `12/39 SELECTED` sayacı (`.vg-count`) ile gelir.

### Bitince: MANUEL mi, RAKİP ANALİZİ mi?

İş tamamlandığında toast çıkar, grid ayı ve rank şeridi tazelenir, loglar
yeniden çekilir (batch satırı REVERT ALL ile görünür) ve bir `choiceBox`
sorar:

- **MANUEL** — yalnız kapat; operatör yeni kuralları elle fiyatlar.
- **RAKİP ANALİZİ** — mevcut kategori modlu SCAN, **tam olarak yeni
  oluşturulan gün ve süreler** üzerinde koşar; sonuçlar her zamanki turuncu
  staged akışına düşer ve APPLY ile yazılır. Matematik çoğaltılmaz: `runScan`
  açık bir `{days, durs, mode}` kapsamıyla çağrılabilecek şekilde asgari
  ölçüde ayrıştırılmıştır (§10).

## 10. Rakip analizi (⌕ ve sıralama yerleştirme)

Rentalcars'ın arama sayfasının kullandığı herkese açık
`/api/search-results` ucuna düz GET atılır (kimlik doğrulaması yok).
Cevap: eşleşme listesi + depot→tedarikçi eşlemesi + puanlar. Panel listeyi
kendi tasarımıyla, tedarikçi logolarıyla (monokrom filtre) gösterir — modal
artık ilk **50** rakibi listeler (RENTALCARS TOP 50). Süre sekmelerinin hemen
altındaki **turuncu chip satırı** her sürenin mevcut yüzdesini taşır: aktif
sürenin chip'i % editörünü açar, pasif süreninki süreyi değiştirir ve taze
veri gelir gelmez editörü otomatik açar.

**Kategori görünümü**: modalın üstündeki **kategori chip satırı**
(`.rc-cats` → ikon + kısa etiket + GM'in o kategorideki sırası) rakip listesini
araç sınıfına göre süzer — HEPSİ / EKONOMİ / KOMPAKT / ORTA BOY / BÜYÜK /
STATION / SUV / MİNİVAN. Kategoriler tek `/api/search-results` cevabındaki
`carCategories` alanından türetilir (ek sorgu yok); yalnız ≥1 teklifi olan
kategoriler gösterilir. Bir kategori seçiliyken tablo, GM sırası/fiyatı,
filo/yerleştirme matematiği ve süre projeksiyonu hep o kategorinin **süzülmüş
görünümü** üzerinde çalışır — az araçla GM kategori merdiveninde daha iyi sıralanır.

**CONFIRM üstte, chip canlı**: simülasyon barı (RESET / CONFIRM → FMX) artık
tablonun **üstünde** durur ve liste kaydırılırken görünür kalır (yapışkan).
Bir yüzde değiştirildiğinde ilgili süre chip'i anında projeksiyon değerine
geçer (parlak turuncu, `.rc-dur-pct-pending`, "beklemede") ve CONFIRM → FMX
başarılı olunca yeni uygulanan değere oturur.

**Yerleştirme matematiği**: hücrenin mevcut yüzdesi C ve GM'in listedeki
fiyatı P biliniyorsa taban `B = P / (1 + C/100)`. Hedef pozisyondaki rakibin
fiyatının ~%0,5 altı hedeflenir; yeni yüzde `(hedef/B − 1) × 100`. CONFIRM →
FMX'e yazılır, doğrulanır, loglanır.

**TOP-10 SWEEP**: ayın aranabilir her günü × seçili süreler (maks 6 gün)
taranır; GM hedef sıranın dışındaysa gereken yüzde hesaplanıp plana eklenir;
plan onaylanınca satır satır uygulanır. Fiyat asla yükseltilmez.

**SCAN (top-10 kalabalıklaştırma)**: grid'deki SCAN butonu ayın aranabilir
her günü × tüm süreleri tarar; hedef, top-10'da en az K=4 GM aracı. Filo
hedeflemedeki matematikle GM'in K. en ucuz aracını (10−K+1). en ucuz rakibin
~%0,5 altına indirecek yüzde hesaplanır ve öneri grid'e **turuncu** olarak
stage'lenir (operatörün kendi girişleri yeşil kalır). Yazma, normal APPLY
onayından geçer ve tüm değişiklikler tek batch kimliğiyle loglanır (bkz. §8
ACTIVITY — REVERT ALL). Fiyat asla yükseltilmez.

**Filo hedefleme (TOP 10'DA GM ARACI)**: tek FMX yüzdesi tüm GM araçlarını
aynı çarpanla ölçeklediği için "top 10'da K araç" hedefi şuna indirgenir:
GM'in K. en ucuz aracı, (10−K+1). en ucuz rakibin ~%0,5 altına inmelidir.
Modaldaki 2–6 düğmeleri bu yüzdeyi hesaplar, tüm GM araçlarının simüle
konumlarını tabloda gösterir; CONFIRM aynı doğrulamalı yazma + canlı senkron
akışını kullanır. Hedef zaten sağlanıyorsa fiyat yükseltilmez, bilgi verilir.

## 11. Market Watch (e-posta uyarıları)

Saatte bir, iki istasyon × 14 gün taranır ve `.rc-watch.json` temel çizgisiyle
karşılaştırılır. Tetikleyiciler: top-5 tedarikçi fiyatında ±%5, GM sırasında
2+ pozisyon, liderlik değişimi. Değişiklikler tek özet mailde gönderilir. Mail
artık **Türkçe ve sade**: sistem yazı tipi, açık temaya uygun aydınlık düzen,
ne olduğunu ve ne yapılması gerektiğini anlatan kısa bir giriş cümlesi,
istasyon başına net TR başlıklı tek tablo (TARİH, NE OLDU, ESKİ → YENİ, ETKİ)
ve tek bir **"Konsolu aç"** düğmesi. Yeşil = GM lehine, kırmızı = tehdit
anlamı korunur (yön okları kalır, üslup Türkçe). **Mobil-posta dostu**: ~600px
ortalanmış, telefonda taşmayan tablolar (yazı ≥14px). Test maili de aynı sade
Türkçe düzendedir. Alıcı mantığı ve tetik eşikleri değişmedi. Not: Microsoft 365'te
SMTP AUTH hem kiracı hem posta kutusu düzeyinde açık olmalı; Security
Defaults kapalı olmalı ya da app password kullanılmalıdır.

## 12. Otomatik tarama ve mail onayı

Market Watch "ne değişti" der; **otomatik tarama** bir adım öteye geçip
"ne yapmalısın" der ve değişikliği tek tıkla uygulatır. Saatlik tick
(`/api/internal/tick`, Market Watch ile aynı dal) `autoScan()` çalıştırır.

**Ufuk ve sorgu bütçesi**: bugünden itibaren içinde bulunulan ay + 2 ay
(`AUTOSCAN.monthsAhead`), iki istasyon, `AUTOSCAN.durations` (şimdilik 3 gün),
alış 19:00. RC sorguları 6 saatlik TTL ile yapılır; önbellekten dönenler
bedavadır, yalnız **gerçekten dışarı çıkan** sorgular sayılır. Bir koşu
`freshBudget` (40) taze sorguyu harcayınca durur ve nerede kaldığını
(`autoscan` anahtarındaki `cursor`) saklar — sonraki saat oradan devam eder,
böylece ufkun tamamı birkaç saate yayılarak taranır ve hiçbir koşu tick'in
300 sn'lik sınırına yaklaşmaz. Mevcut yüzdeler istasyon+ay başına bir kez
çekilen grid verisinden okunur (hücre başına yeniden sorgu yok).

**Kategori çarpanı (canonical matematik)**: tek FMX yüzdesi tüm GM
tekliflerini aynı çarpanla ölçeklediği için "her kategoride hedef sıra R'nin
içinde ol" hedefi tek bir sayıya iner. GM'in de rakibin de teklifi olan her
görüntü kategorisi c için `anchor_c` = o kategoride hedef sıradaki rakip
fiyatı, `gmCheap_c` = GM'in o kategorideki en ucuz teklifi,
`f_c = anchor_c × 0,995 / gmCheap_c`; **çarpan = min(f_c)** — en dar kategori
yönetir. Yeni yüzde `((1 + C/100) × çarpan − 1) × 100`, [−95, 100] aralığına
kırpılır.

**İki yönlü öneri**: `çarpan < 1` ise fiyat **düşmeli** (hedef sıraya
girilemiyor); `çarpan > 1 + raiseThreshold` (0,08) ise GM gereğinden ucuzdur ve
fiyat **yükseltilebilir** — masada bırakılan marj. Yeni yüzde mevcuttan en az
`minChangePct` (1,5 puan) farklı değilse öneri üretilmez.

**Öneri kaydı ve mail**: öneriler `proposals` anahtarında (kalıcı, son 10 set)
`{id, createdAt, source, status, items…}` olarak tutulur; `status` =
`pending` / `applied` / `superseded`. Mail **yalnız** yeni set son bekleyen
setten farklıysa gider (`istasyon:yıl-ay-gün:süre:yeniYüzde` imzası
karşılaştırılır) — aynıysa set sessizce tazelenir ve **id korunur**, böylece
daha önce gönderilmiş maildeki bağlantı geçerli kalır. Yeni bir set
maillendiğinde eski bekleyen setler `superseded` olur. Mail Türkçe ve §11'deki
sade düzendedir: konu `[GM] Otomatik tarama — {n} fiyat önerisi`, istasyon
başına bir tablo (TARİH, SÜRE, ŞİMDİ → ÖNERİ, NEDEN), NEDEN sütunu yöneten
kategoriyi ve sırayı söyler (`ekonomi: #6 → #3`); düşüş yeşil, yükseliş
turuncu. En fazla 40 satır, gerisi "… ve {k} kayıt daha".

**Tek tıkla onay — iki adımlı, bilinçli olarak**: maildeki düğme
`GET /p/:id?t=<token>` açar ve bu uç **hiçbir şey uygulamaz** — yalnız
değişiklikleri listeleyen Türkçe bir onay sayfası basar. Sebep: mail
istemcileri ve güvenlik tarayıcıları GET bağlantılarını önden çeker; GET'te
uygulasaydık kimse tıklamadan fiyatlar yazılırdı. Uygulama, o sayfadaki
formun `POST /p/:id/apply` göndermesiyle olur. Token
`b64u(hmac_sha256(authSecret, 'proposal:' + id + ':' + createdAt))`ın ilk 32
karakteridir, sabit zamanlı karşılaştırılır ve `createdAt` + 72 saat sonra
geçersizdir. Bu yol `/api` altında **değildir** (operatör çerezini bilerek
atlar, SPA catch-all'dan önce mount edilir, `Cache-Control: no-store`).
Yazmalar konsolun kullandığı aynı doğrulamalı kural yazma yolundan geçer ve
`batch: id`, `batchTag: 'autoscan'` ile loglanır — yani ACTIVITY'de tek satır
olarak toplanır ve **REVERT ALL** ile geri alınabilir. Aynı set ikinci kez
POST edilirse "bu öneri zaten uygulandı" cevabı döner. Uygulama sonrası
dokunulan günlerin RC önbelleği silinir ve kısa bir Türkçe onay maili gider
(`[GM] Öneriler uygulandı — {ok} değişiklik`).

**Konsol tarafı**: `GET /api/proposals` setleri listeler,
`POST /api/proposals/:id/apply` aynı motoru operatör çereziyle çalıştırır.
Dashboard'daki MARKET WATCH kartı otomatik tarama satırlarını gösterir
(durum, son koşu, bekleyen öneri sayısı) ve bekleyen set varsa oradan da tek
tıkla uygulanır. `/api/watch-status` bunun için `autoScan` bloğu taşır.

**Uygulama sonrası ÖNCE/SONRA penceresi**: grid'de SCAN önerileri APPLY
edildiğinde konsol bir karşılaştırma modalı (`.modal.modal-rc`) açar: kaç
gün/süre hücresinin değiştiği ve ortalama hareket, kategori bazlı
**önce/sonra ortalama sıra** tablosu (`.cmp-table`; iyileşme yeşil `.cmp-up`,
hareketsiz gri `.cmp-flat`) ve gün gün detay listesi (`.cmp-detail` — gün ·
süre · eski% → yeni% · kıpırdayan kategoriler). Modal açılırken rapor maili
(`POST /api/report/scan-apply`) kendiliğinden bir kez gönderilir; **RAPORU
MAİLLE** düğmesi aynı maili yeniden yollar. 375px'te tablo dört sütunuyla
sayfayı yana kaydırmadan sığar, detay listesi modalın kendi kaydırmasını
kullanır.

## 13. Rapor mailleri açma/kapama

Otomatik tarama (§12) ve Market Watch (§11) mailleri artık **kişi başına**
açılıp kapatılabilir.

- `prefs` store anahtarı uid'e göre bölündü:
  `{ <uid>: { mailTo, reports: true|false } }`. **Geriye dönük uyumlu**: eski
  düz `{mailTo}` şekli boot sırasında tohum admin uid'inin altına taşınır.
- `GET /api/prefs` ve `POST /api/prefs` **her zaman çağıranın uid'i** üzerinde
  çalışır — gövdeden gelen bir uid dikkate alınmaz.
- `reports: false` demek: *bu operatör* otomatik tarama / market watch rapor
  maillerinin dışında kalır. Diğer kullanıcılar etkilenmez.
- `mailRecipient()` yerine `mailRecipients()`: `reports !== false` olan
  kullanıcıların adreslerini döndürür; hiçbiri yoksa `SMTP_TO` varsayılanına
  düşülür. `sendMail` bu listeyi alır.
- Arayüz: Settings → mevcut **ALERT MAIL** alanının yanında **REPORT MAILS**
  anahtarı (`.switch`) ve tek satırlık not — kapatmanın yalnız *bu* hesaba
  giden mailleri durdurduğunu söyler.

## 14. Önbellekler ve Canlı Senkron

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

## 15. Bulut dağıtımı ve RC Relay

Panel `sentinelpricing.web.app`'te 2. nesil bir HTTPS function olarak çalışır
(tek instance — `maxInstances: 1`; FMX yazma kuyruğu, relay iş kuyruğu ve
login hız sınırı bellekte olduğundan bu bilinçli bir tercihtir). Kalıcı durum
Firestore'da, yeniden üretilebilir önbellekler `/tmp`'dedir.

- **Operatör girişi**: her `/api` çağrısı, Firebase girişinden sonra verilen
  HMAC imzalı `__session` çerezini gerektirir (bkz. §2); `/api/login` de artık
  bu çerezi ister ve yalnızca FMX oturumunu bağlar. `/api/login` IP başına hız
  sınırlıdır (15 dakikada 8 başarısız deneme → 429).
- **Zamanlayıcı**: Cloud Scheduler 4 dakikada bir `/api/internal/tick`'i
  çağırır (INTERNAL_SECRET ile). Tick, FMX oturumunu canlı tutar, saati gelen
  Market Watch taramasını çalıştırır ve instance'ı sıcak tutar.
- **RC Relay (ham protokol)**: rentalcars, veri merkezi IP'lerini (Google
  Cloud dahil) HTTP 405 ile reddeder. Buluttaki konsol rentalcars sorgularını
  operatör makinelerinde çalışan relay'lere devreder. Protokol **ham**dır:
  konsol işi `{id, url, headers}` olarak verir, relay o URL'yi olduğu gibi
  çeker ve `{id, ok, status, body}` (ham cevap metni) POST'lar — tüm
  ayrıştırma sunucu tarafındadır, relay'in hiçbir kütüphaneye ihtiyacı yoktur.
  Relay yalnızca `www.rentalcars.com`'a istek atar (host sabitlenmiştir; başka
  URL `BAD_URL` ile reddedilir). Eski relay'lerin ayrıştırılmış `{id, ok, data}`
  cevabı da kabul edilmeye devam eder (çift format, kalıcı). Relay yalnızca
  dışa doğru HTTPS uzun-polling yapar; port açılmaz, RELAY_SECRET ile
  doğrulanır. Hiç relay çevrimiçi değilken panel önbellekteki son veriyi
  `STALE` etiketiyle gösterir, hiç veri yoksa net bir açıklama basar; FMX/grid
  tarafı relay'den tamamen bağımsız çalışır.
- **Çoklu makine kurulumu**: Settings → SYSTEM'deki RELAY kartından her makine
  için installer indirilir — `MAC` (`bash ~/Downloads/install-gm-relay.sh`,
  terminale yapıştırılır) veya `WINDOWS` (indirilen `install-gm-relay.bat`
  dosyasına **çift tıklanır** — terminal veya PowerShell penceresi açmaya
  gerek yok; kendi içine gömülü PowerShell'i kendisi çalıştırır).
  Kurulum makine başına bir keredir: relay girişte otomatik başlar, çökerse
  yeniden başlatılır, yeniden başlatmalardan sağ çıkar. Birden çok relay aynı
  anda çevrimiçi olabilir; iş, ilk poll'layana gider. Her relay kendini
  `x-relay-name` başlığıyla (hostname) tanıtır: bağlı worker listesi
  Settings'te, ilk worker adları dashboard'daki RC RELAY satırında görünür;
  hepsi çevrimdışıyken topbar'da `RC RELAY OFFLINE` chip'i belirir (3 dakikada
  bir tazelenir). İndirilen installer dosyası RELAY_SECRET içerir — başarılı
  kurulumda kendini Downloads'tan siler; kurulum başarısız olursa dosyayı elle
  silin.
- **macOS ayrıntısı**: installer `~/GMPricingRelay/relay.js` (chmod 600, log:
  `~/GMPricingRelay/relay.log`) ve `~/Library/LaunchAgents/com.gm.pricing-relay.plist`
  yazar; bu depodaki eski LaunchAgent ile aynı Label'ı kullanır, installer onu
  değiştirir. Kaldırmak: `launchctl bootout gui/$UID/com.gm.pricing-relay`,
  sonra plist ve `~/GMPricingRelay` silinir. `npm start` de `.secrets.json`'daki
  `relay` bloğu varsa süreç-içi bir relay başlatır — kurulu agent ile aynı
  makinede aynı isimde iki poller oluşur, zararsızdır.
- **Windows ayrıntısı**: installer `%LOCALAPPDATA%\GMPricingRelay\relay.ps1`
  yazar ve "GM Pricing Relay" adlı Scheduled Task kaydeder (saf PowerShell 5.1,
  Node gerekmez; pilde de başlar ve durmaz). PowerShell relay işleri sırayla
  yürütür (Node relay 4 paralel) — yalnız Windows'lu bir filo ay taramasını
  daha yavaş bitirir, beklenen davranıştır. Kaldırmak:
  `Unregister-ScheduledTask "GM Pricing Relay"` + `%LOCALAPPDATA%\GMPricingRelay`
  klasörünü silmek.
- **RELAY_SECRET rotasyonu**: `.env`'e yeni değer yazılır (yalnız `A-Za-z0-9_-`
  karakterleri — değer installer şablonlarına birebir gömülür), function
  yeniden deploy edilir, her makinede installer yeniden indirilip çalıştırılır.
  Eski secret'lı relay'ler yeniden kurulana kadar loglarına 60 sn'lik 401
  backoff satırı yazar.
- **Dağıtım sırası**: önce function deploy edilir, relay'ler ondan sonra
  yeniden kurulur/başlatılır. Ham relay eski sunucudan `url`'siz iş alırsa
  `NO_URL` hatası POST'lar ve panel eski önbelleğe (`STALE`) düşer — yeni
  sunucu yayına girene kadar kendini açıklayan, sınırlı bir bozulma.
- **Tek oturum (authGen)**: her başarılı `/api/login`, kalıcı oturum neslini
  (`authGen`, Firestore `state/auth`) bir artırır ve yeni çerez bu nesille
  (`g` alanı) imzalanır. Eski nesil çerez taşıyan her cihaz anında 401
  `SESSION_REPLACED` alır; eski cihazda "başka cihazdan giriş yapıldı" mesajı
  gösterilir. İki bilinen davranış: (1) bu dağıtımdan önce verilmiş çerezlerde
  `g` alanı yoktur — dağıtım sonrası ilk temasta her operatör bu mesajı
  **bir kez** görür (gerçekte kimse başka yerden girmemiş olsa bile);
  (2) ikinci bir operatör FMX adımını tamamladığında ilkinin çerezi ölür —
  bu yüzden hem `api()` hem de FMX giriş modalı, 401 `SESSION_REPLACED` /
  `NOT_SIGNED_IN` görünce çerezi canlı Firebase oturumundan **bir kez**
  yeniden basar ve isteği tekrarlar; ancak bu da başarısız olursa operatöre
  hata gösterilir.
- **`/` açılış sayfası**: Firebase Hosting site kökünde `landing/` klasörünü
  yayınlar. Bu sayfanın artık kendi giriş kapısı yoktur (eskiden `/api/login`
  POST'luyordu; `/api/login` Firebase çerezi istediğinden bu akış işlemez
  hâle gelmişti) — sayfa yalnızca `/console` bağlantısı sunar, tek gerçek
  giriş kontrolü konsolun Firebase kapısıdır.
- **Backup ilerlemesi**: restore point oluşturma artık `GET /api/backup/stream`
  (SSE) üzerinden akar — `meta` / `progress` / `done` / `fail` olayları; buton
  canlı sayaç gösterir (örn. `120/415`). `done` olayı `failed` sayısı taşır:
  detayı alınamayan kural varsa nokta uyarıyla işaretlenir (eksik kural içeren
  bir restore point, geri yüklemede o kuralları silme olarak yorumlar).
- **RC önbellek geçersizleştirme**: grid APPLY, log REVERT ve RESTORE
  tamamlanınca dokunulan günlerin sunucu RC önbelleği silinir ve dashboard'daki
  RC MARKET RANK şeridi zorla yenilenir. Relay çevrimdışıyken şeritteki eski
  hücreler soluk/kesikli `STALE` stiliyle işaretlenir.
- **Odak senkronu**: sekmeye dönüşte (focus/visibilitychange) loglar 60
  saniyeden, grid ve rank şeridi 10 dakikadan eskiyse otomatik tazelenir;
  oturum bu arada başka cihazca devralındıysa aynı anda "başka cihazdan giriş"
  mesajı gösterilir.

## 16. Diğer eklentiler

- **Uyarı maili alıcısı**: Settings → ALERT MAIL — operatör kendi adresini
  kaydeder (`/api/prefs`, Firestore'da kalıcı, artık uid başına); boş
  kaydetmek SMTP_TO varsayılanına döndürür. Yanındaki REPORT MAILS anahtarı
  bu hesabı rapor maillerinin dışında bırakır — bkz. §13. Watcher maili artık renk kodlu (yeşil=GM lehine,
  kırmızı=tehdit), açıklamalı giriş cümleli ve "OPEN CONSOLE" düğmeli.
- **Analitik yorumları**: ANALYTICS'te grid + rank verisinden türetilen
  otomatik değerlendirme cümleleri (ortalama, en derin indirim, hafta sonu/içi,
  kapsama, sıra özeti). İndirim rozetleri Palantir turuncusu; tedarikçi
  logoları her zaman orijinal renkte.

## 17. Kurulum ve yapılandırma

```bash
npm install
npm start        # http://localhost:4646
```

- İstasyonlar: kalıcı `tenants` store anahtarı (Settings → STATIONS kartı,
  admin) — bkz. §4. Süreler: `server.js` başındaki `DURATIONS`.
- Watcher ayarları: `server.js` içindeki `WATCH` (aralık, gün sayısı, eşikler).
- Otomatik tarama ayarları: `server.js` içindeki `AUTOSCAN` (`enabled`,
  `targetRank`, `durations`, `raiseThreshold`, `monthsAhead`, `freshBudget`,
  `minChangePct`) — bkz. §12.
- SMTP: `.secrets.json` (`smtp.host/port/user/pass/from/to`).
- HUD ölçeği, tema, saat rotasyonu tarayıcı localStorage'ında tutulur.
