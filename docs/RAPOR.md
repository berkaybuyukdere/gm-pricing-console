# Kısa Rapor — Neler Yaptık

**Proje:** GM Pricing Console — FuseMetrix haftalık fiyat kurallarını hızlı
yönetip rentalcars.com pazarını canlı izleyen yerel panel (Palantir tarzı).

## Çıkış noktası

FMX'in Weekly Rules ekranında her gün × süre için kural açmak/deşiştirmek
çok yavaştı. Önce sistemin nasıl işlediğini tersine mühendislikle çıkardık:
kayıt POST'ları, istasyon bağlamının oturumda taşınması, kural semantiği ve
fiyatların brokerlara XML pull ile gitmesi ağ trafiği izlenerek doğrulandı.

## İnşa edilenler (kronolojik)

1. **Fiyat grid'i** — gün × 2/3/4/5/6+ gün matrisi; hücreye yüzde yaz,
   topluca APPLY; her yazma FMX'ten geri okunarak doğrulanır; satır/sütun
   doldurma; Zurich Airport + Zurich Downtown.
2. **Panel içi FMX girişi** — kullanıcı adı/şifre panelde; oturum otomatik
   canlı tutulur, düşerse otomatik yeniden girilir. Şifre yalnız bellekte.
3. **Hız katmanı** — kural detayları disk önbelleği (yalnız FMX'te değişen
   kural yeniden çekilir), SSE ile hücrelerin tek tek akışı, ay bazlı
   istemci önbelleği (aylar arası geçiş anında), yazma başına istek sayısının
   yarıya indirilmesi.
4. **Sayfalar** — Dashboard (açılış), Pricing Grid, Analytics, Activity;
   sol menü yalnız navigasyon.
5. **Aktivite logu + REVERT** — kim/ne zaman/hangi tarih-süre/ne idi→ne
   oldu; her kayıt tek tıkla geri alınabilir.
6. **Geri dönüş noktaları** — tüm kuralların anlık görüntüsü; kuru-çalışma
   diff'i gösterip seçilen istasyon+ay'ı o ana döndürür.
7. **Ay kopyalama** — bir ayın tüm grid'i başka aya staged olarak taşınır.
8. **Uyarılar** — kuralsız gelecek günlere işaret + sayaç.
9. **Vendor hedefleme** — yazmalar istenirse tek kanala (ör. sadece bir
   broker) gidebilir.
10. **Rakip analizi (⌕)** — rentalcars'ın kendi arama API'sinden canlı
    top-10: tedarikçi (monokrom logo), araç, puan, fiyat; Green Motion
    satırları vurgulu. Veriler sitenin gösterdikleriyle birebir doğrulandı.
11. **Sürükle & yerleştir fiyatlama** — GM satırını istediğin sıraya bırak
    (veya rakip satıra tıkla); gereken FMX yüzdesi otomatik hesaplanır,
    CONFIRM ile yazılır.
12. **RC MARKET RANK** — dashboard'da ayın her günü için GM'in sırası
    (renk kodlu şerit, 6 saat önbellek, güne tıkla → top-10).
13. **TOP-10 SWEEP** — tek tuşla tüm ay: GM hedef sıranın dışında kaldığı
    her gün×süre için plan çıkarılır, onayla satır satır FMX'e uygulanır
    (maks 6 gün; fiyat asla yükseltilmez).
14. **Market Watch** — saatlik tarama; rakip fiyatı ±%5 oynarsa, GM sırası
    2+ değişirse veya lider değişirse Palantir tarzı HTML e-posta uyarısı.
15. **Canlı Senkron** — FMX'e yazınca o günün RC önbelleği silinir; 2/5/10.
    dakikalarda taze sorguyla fiyatın rentalcars'ta canlıya düştüğü
    doğrulanır (toast + şerit güncellemesi + CHECK NOW).
16. **Arayüz** — koyu/açık tema, HUD ölçeği, ekrana tam oturan grid,
    doğrulanmış renk körlüğü güvenli grafik paleti, sayfa geçiş efekti.

## Bilinen dış bağımlılıklar

- **rentalcars gecikmesi:** FMX yazımı anlıktır; rentalcars kendi teklif
  önbelleğini tazeleyene kadar (dakikalar) sitede eski fiyat görünebilir.
  Canlı Senkron bunu izler ve canlıya düşünce bildirir.
- **SMTP:** Microsoft 365'te SMTP AUTH kiracı + posta kutusu düzeyinde açık
  olmalı; Security Defaults kapalı olmalı ya da app password kullanılmalı.
  (Kod hazır; kiracı ayarı açılınca TEST MAIL tek tık.)
