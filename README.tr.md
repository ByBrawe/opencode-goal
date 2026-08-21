# OpenCode Goals

**Dil:** [English](./README.md) · **Türkçe**

[![npm version](https://img.shields.io/npm/v/%40bybrawe%2Fopencode-goal)](https://www.npmjs.com/package/@bybrawe/opencode-goal)
[![npm downloads](https://img.shields.io/npm/dm/%40bybrawe%2Fopencode-goal)](https://www.npmjs.com/package/@bybrawe/opencode-goal)
[![license](https://img.shields.io/npm/l/%40bybrawe%2Fopencode-goal)](./LICENSE)

**OpenCode için kalıcı, host tarafından doğrulanan Goal modu.**

OpenCode Goals, uzun süren yapay zeka kodlama görevleri için bir **OpenCode goal eklentisidir**. Kalıcı bir `/goal` iş akışı ekleyerek OpenCode kodlama ajanının tek bir açık hedefi birden fazla tur, context compaction, kesintiler, delege edilen işler ve süreç yeniden başlatmaları boyunca korumasını sağlar. Tamamlanma ise executor modelinin yalnızca “bitti” demesine değil, güncel host kanıtlarına bağlıdır.

Bir **OpenCode autonomous agent**, **persistent goal mode**, **multi-turn coding agent**, **OpenCode için Codex tarzı uzun süreli goal workflow** veya **bağımsız completion verification** sunan bir OpenCode eklentisi arıyorsanız bu paket bu kullanım için tasarlanmıştır.

> Bağımsız OpenCode eklentisidir. “Codex tarzı” ifadesi yalnızca uzun süreli goal workflow modelini anlatır; herhangi bir onay, bağlantı veya özellik eşitliği iddiası değildir.

## Kurulum veya güncelleme

Önerilen tek komutlu kurulum:

```bash
npx -y @bybrawe/opencode-goal@latest
```

Güncellemek istediğinizde aynı komutu yeniden çalıştırın.

Alternatif olarak installer'ı global kurabilirsiniz:

```bash
npm install -g @bybrawe/opencode-goal@latest
opencode-goal
```

Ardından **OpenCode'u tamamen kapatıp yeniden açın** ve doğrulayın:

```text
/goal status
```

OpenCode slash-command listesinde `/goal` komutunu da görmelisiniz.

Yalnızca `npm install @bybrawe/opencode-goal` çalıştırmak paketi mevcut Node projesine kurar. Eklentiyi OpenCode'a kaydetmez. Yukarıdaki `npx` installer'ını veya global installer komutunu kullanın.

### Installer ne yapar?

Installer:

- global OpenCode config dizinini bulur;
- config yoksa oluşturur;
- OpenCode plugin listesine `@bybrawe/opencode-goal@<exact-version>` ekler ve exact sürüme sabitler;
- eski, sürümsüz veya `@latest` Goal plugin kayıtlarını yükseltir;
- bilinen yinelenen eski yerel Goal plugin kopyalarını kaldırır;
- `/goal` komutunun keşfedilebilir olması için yönetilen global `commands/goal.md` dosyasını kurar;
- yönetilen plugin dizisi dışındaki ilgisiz OpenCode ayarlarını ve JSONC yorumlarını korur.

Varsayılan OpenCode konumları:

macOS / Linux:

```text
~/.config/opencode/opencode.json or opencode.jsonc
~/.config/opencode/commands/goal.md
```

Windows:

```text
%USERPROFILE%\.config\opencode\opencode.json or opencode.jsonc
%USERPROFILE%\.config\opencode\commands\goal.md
```

OpenCode npm paketini özel `./server` entrypoint'i üzerinden yükler. Root export normal JavaScript API'si olarak kalır.

## Neden OpenCode Goals?

Normal coding-agent konuşmaları çok sayıda tur, compaction, retry veya kesinti sonrasında ilk sonucu/hedefi kaybedebilir. OpenCode Goals başarı sınırını açık ve kalıcı tutar.

Temel özellikler:

- **Turlar arasında kalıcı Goal** — hedef autonomous continuation boyunca aktif kalır.
- **Uzun süreli agent workflow** — OpenCode idle sınırlarından sonra Goal'a ait çalışmayı sürdürebilir.
- **Host-verified completion** — shell kontrolleri, file contracts, mutation evidence ve güncel workspace durumu plugin tarafından doğrulanabilir.
- **Bağımsız semantic verifier** — executor yalnızca işin bittiğini söylediği için kendisini başarılı ilan edemez.
- **False-completion koruması** — eksik, eski, dolaylı veya uydurulmuş kanıt fail-closed davranışıyla reddedilir.
- **Multi-turn cadence koruması** — “10 ayrı turda her seferinde tam +1 yap” gibi hedefler yalnızca final dosya değerine bakılarak kanıtlanmaz.
- **Restart recovery** — proje içindeki state, OpenCode/süreç yeniden başlatmalarından sonra korunur.
- **Compaction persistence** — Goal context korunurken model context penceresini OpenCode yönetmeye devam eder.
- **Budget'lar** — turn, token, runtime ve isteğe bağlı cost limitleri autonomous çalışmayı sınırlar.
- **Goal queue** — tek bir canlı Goal korunurken gelecekteki Goal'lar inert sıralı queue içinde hazırlanabilir.
- **Windows / macOS / Linux paketleme** — installer ve package smoke coverage çapraz platformdur.

## Hızlı başlangıç

Gerçek bir doğrulama komutuyla Goal başlatın:

```text
/goal fix the failing tests --check "npm test"
```

Daha kapsamlı bir Goal Contract oluşturun:

```text
/goal refactor auth \
  --success "all auth tests pass" \
  --success "existing callers remain compatible" \
  --constraint "do not add a runtime dependency" \
  --non-goal "do not redesign unrelated session code" \
  --check "npm test"
```

Canlı contract ve proof durumunu inceleyin:

```text
/goal status
/goal contract
/goal audit
```

Duraklatın ve devam ettirin:

```text
/goal pause
/goal resume
```

Goal paused durumundayken `devam et`, `continue` veya `resume` gibi kısa ve açık bir devam mesajı da aynı lifecycle control zinciri üzerinden Goal'ı yeniden aktive eder. Diğer normal chat mesajları paused Goal'ı sessizce yeniden başlatmaz.

Gelecekteki Goal'ları sıraya ekleyin:

```text
/goal add update docs --success "docs match shipped behavior"
/goal add prepare release notes --check "npm test"
/goal queue
```

## Yaygın kullanım alanları

OpenCode Goals, bir AI coding agent'ın gerçek bir sonuç elde edilene kadar hedefi koruması gerektiğinde kullanışlıdır. Örneğin:

- başarısız bir test suite'ini birçok iterasyonda düzeltmek;
- refactor veya migration işini birden fazla model turunda sürdürmek;
- “N ayrı tur/cycle” gibi zamansal çalışma gereksinimlerini zorunlu tutmak;
- hedefi context compaction boyunca korumak;
- OpenCode kapatılıp yeniden açıldıktan sonra yarım kalan işi geri yüklemek;
- autonomous coding sırasında erken “bitti” iddialarını engellemek;
- completion öncesi file evidence, shell checks veya semantic verification istemek;
- aynı projede ayrı OpenCode session'larında bağımsız Goal'lar çalıştırırken Goal state'lerini izole tutmak.

## Temel komutlar

| Komut | Amaç |
|---|---|
| `/goal <objective>` | Bitmemiş canlı Goal yokken yeni Goal başlatır |
| `/goal status` | Mevcut Goal durumunu gösterir |
| `/goal contract` | Objective, criteria, constraints, checks, files ve limitleri gösterir |
| `/goal audit` | Proof/evidence ve mevcut completion gate'i inceler |
| `/goal edit <objective>` | Mevcut Goal'ın yeni revision'ını oluşturur |
| `/goal pause` | Autonomous Goal continuation'ı duraklatır |
| `/goal resume` | Uygun paused Goal'ı açıkça yeniden aktive eder |
| `/goal budget` | Yerel execution limitlerini inceler/değiştirir |
| `/goal list` | Proje çapındaki canlı Goal index'ini read-only gösterir |
| `/goal doctor` | Live/archive/queue storage'ı yeniden yazmadan teşhis eder |
| `/goal add <objective>` | Gelecek için inert bir Goal Contract sıraya ekler |
| `/goal queue` | Queue'yu inceler, yeniden sıralar veya öğe kaldırır |
| `/goal next` | Bitmemiş canlı Goal engellemiyorsa sıradaki Goal'ı promote eder |
| `/goal history` | Arşivlenmiş Goal'ları inceler |
| `/goal restore <id>` | Bitmemiş arşiv Goal'ını paused olarak geri yükler |
| `/goal clear` | Mevcut canlı Goal'ı clear/archive eder |

## İkinci bir Goal başlatabilir miyim?

Tek bir OpenCode **session'ında en fazla bir bitmemiş canlı Goal** bulunur. Böylece aynı session içinde iki autonomous controller'ın birbiriyle yarışması engellenir.

Bir Goal zaten active veya paused durumdaysa:

- mevcut Goal'ı revize etmek istiyorsanız `/goal edit <objective>` kullanın;
- ikinci Goal'ı daha sonra çalıştırmak için `/goal add <objective>` kullanın;
- mevcut Goal'ı bilerek bırakıp/arşivleyip başka bir Goal başlatmak istiyorsanız `/goal clear` kullanın;
- iki Goal'ı bilinçli olarak paralel çalıştırmak istiyorsanız **ayrı bir OpenCode session'ı** kullanın.

Queue için:

```text
/goal add second objective
/goal queue
/goal next
```

`/goal next`, yalnızca bitmemiş canlı Goal promotion'ı engellemiyorsa sıradaki Goal'ı aktive eder.

Ayrı session'lar ayrı kalıcı Goal snapshot'larına sahiptir. Bu nedenle aynı proje dizininde farklı Goal'lar çalıştırabilirler; ancak iki session aynı proje dosyalarını değiştirirse normal workspace çakışmaları yine oluşabilir.

## Pause ile normal chat farkı: açık devam isteği ve sıradan chat

`/goal pause`, kalıcı Goal durumunu `paused` yapar. `/goal resume`, Goal'ı yeniden aktive etmek için açık lifecycle komutu olarak kalır.

Kolaylık için `devam et`, `continue`, `kaldığın yerden devam et` veya `resume` gibi kısa ve belirsiz olmayan devam mesajları, Goal paused durumundayken resume niyeti olarak kabul edilir. Plugin bu niyeti Goal state'ini doğrudan değiştirmek yerine mevcut `/goal resume` command/ownership zinciri üzerinden geçirir.

Diğer foreground chat mesajları normal konuşma olarak kalır ve Goal'ı **sessizce yeniden aktive etmez**. Böylece rastgele chat lifecycle control'e dönüşmezken açık bir “devam et” isteği beklenen davranışı verir.

Aynı resume yolu fail-closed verifier kesintisi sonrasında da kullanılabilir. Timeout sınıfındaki bir verifier hatası önce taze bir verifier session'ında tek ve bounded bir otomatik retry alır; bu retry de başarısız olur ve Goal `paused` olarak kalıcılaştırılırsa verifier/provider kullanılabilir olduğunda `/goal resume` veya kısa ve açık bir devam mesajıyla completion yeniden denenebilir.

## Goal Contracts

Tekrarlanabilir contract flag'leri success ve hard boundary'leri tanımlar:

```text
--success "..."
--accept "..."
--constraint "..."
--non-goal "..."
--check "..."
--contains "file::required text"
--max-turns <n>
--max-tokens <n>
--max-minutes <n>
--max-cost <amount>
```

Yeni Goal'larda cumulative token limiti varsayılan olarak yoktur (`maxTokens: 0`). Toplam çalışma için açık bir runaway guard istediğinizde `--max-tokens` veya `/goal budget --max-tokens` kullanın; bu cumulative budget seçilen modelin güncel context/input penceresinden ayrıdır.

Tam objective her zaman gerekli bir semantic requirement olarak kalır. Dar kapsamlı kontroller ek proof obligations oluşturur; geniş sonucu asla değiştirmez veya yerine geçmez.

`/goal edit` yeni bir revision oluşturur. Eski revision'a ait kanıtlar düzenlenmiş Goal'ı sessizce kanıtlayamaz.

## Multi-turn cadence ve anti-batching

OpenCode Goals, açıkça birden fazla ayrı tur/cycle isteyen objective'ler için tasarlanmıştır.

Örnek:

```text
/goal 10 ayrı goal turunda counter.json içindeki value değerini her tur tam +1 artır. Başlangıç 0, final 10. Tek seferde +10 yapma.
```

Bu tip objective'lerde plugin, mevcut revision boyunca host tarafından gözlenen workspace mutation fingerprint'lerini ve Goal progress bilgisini takip eder. Model işi tek seferde batch etmek yerine istenen per-turn birimini yapıp turu bitirmelidir.

Yalnızca final `{"value":10}` değeri, on ayrı +1 turunun gerçekleştiğini kanıtlamaz.

## Native OpenCode Todo orchestration

Geniş multi-step işler için OpenCode Goals, OpenCode'un native Todo planlamasıyla koordineli çalışır ancak Todo state'i Goal proof olarak kabul edilmez.

Sınır nettir:

- Todo text/status Goal evidence olmaz;
- Todo completion tek başına Goal progress artırmaz;
- Todo, kullanıcının yetki verdiği Goal scope'unu genişletemez;
- güncel Todo planında `pending` veya `in_progress` iş varsa completion veto edilir;
- tamamen bitmiş Todo planı bile Goal'ı kanıtlamaz;
- eksik veya stale Todo telemetry daha yeni Goal revision'ını engelleyemez.

## Completion bütünlüğü

Completion bir audit pipeline'ıdır:

1. yapılandırılmış shell check'leri host üzerinde çalışır ve gerçek sonuç/output digest kaydedilir;
2. tanımlı file contract'lar plugin tarafından proje sınırları içinde yeniden okunur;
3. semantic requirement'lar ayrı, read-only bir verifier session'ına gönderilir;
4. verifier citation'ları güncel files/evidence ile karşılaştırılır;
5. zamansal requirement'lar için mevcut revision'a ait host-observed turn/progress gerçekleri kullanılabilir;
6. stale, uydurulmuş, dolaylı veya başarısız evidence reddedilir;
7. güncel native Todo işi yeniden kontrol edilir;
8. `completed` state'i yazılmadan önce her gerekli ledger öğesi proven olmalıdır.

Verification kullanılamıyorsa, eksikse, stale/ambiguous ise veya lifecycle değişikliğiyle race oluşursa completion **fail closed** olur.

### Verifier timeout / bounded retry / Goal paused kalıyor

Executor işi bitirmiş olsa bile bağımsız semantic verification timeout sınıfındaki bir altyapı hatasına ulaşırsa plugin timeout olan verifier child'ını abort edip temizler ve **bir kez** taze verifier session'ıyla otomatik retry yapar. Bu retry en fazla 60 saniyedir; yapılandırılmış verifier timeout daha düşükse o düşük değer kullanılır. Üçüncü bir otomatik verifier denemesi yoktur.

Timeout dışındaki provider veya transport hataları otomatik retry edilmez. Bounded timeout retry da başarısız olursa Goal sonsuz completion retry döngüsüne girmek yerine `paused` olarak kalıcılaştırılır. Mevcut host evidence korunur.

Verifier/provider tekrar sağlıklı olduğunda:

```text
/goal resume
```

kullanın. `devam et` veya `continue` gibi kısa ve açık bir mesaj da aynı resume yolunu kullanır.

Verifier kesintisi kanıtlanmamış bir Goal'ı hiçbir zaman completed olarak işaretlemez.

## Persistence ve restart recovery

Project-local state:

```text
.opencode/goals/
.opencode/goal-sequences/
.opencode/goal-locks/
```

Runtime; atomic writes, optimistic generation/CAS protection, per-session ownership, process leases, path/symlink escape protection, corrupt-state fail-closed handling ve process-restart recovery içerir.

Goal cumulative token/runtime budget'ları seçilen modelin mevcut context penceresinden bilinçli olarak ayrıdır. `/goal status`, host tarafından gözlenen full context pressure bilgisini ve model daha küçük bir input limiti sunuyorsa input-side pressure bilgisini ayrı gösterir. Ne zaman compact yapılacağına OpenCode karar vermeye devam eder.

Aktif bir Goal session'ı sahiplenmişken plugin, OpenCode'un generic post-compaction synthetic continue davranışını kapalı tutar ve tam bir kez Goal-owned guarded continuation yolundan devam eder. Böylece compaction sonrasında elle `continue` yazmak gerekmez ve iki ayrı continuation owner birbiriyle yarışmaz.

## Sorun giderme

### `/goal` yok veya command bridge modele ulaşıyor

Yeniden kurun/güncelleyin:

```bash
npx -y @bybrawe/opencode-goal@latest
```

Ardından:

1. installer'ın exact package pin ve yönetilen `/goal` komutunu raporladığını doğrulayın;
2. global OpenCode config dizininde `commands/goal.md` bulunduğunu doğrulayın;
3. tüm OpenCode CLI/TUI/Desktop süreçlerini tamamen kapatıp yeniden açın;
4. OpenCode'u external plugin'leri kapatan `--pure` ile başlatmayın;
5. plugin-load hataları için OpenCode config diagnostics'i inceleyin.

Installer kullanıcıya ait bir `commands/goal.md` dosyasının üzerine yazmaz.

### Completion işi bittiği halde Goal paused

Şunları kontrol edin:

```text
/goal status
/goal audit
```

Stop reason bounded otomatik retry sonrasında verifier infrastructure/timeout ise ve workspace zaten doğruysa istenen mutation'ları elle tekrar etmeyin. Completion yolunu yeniden denemek için `/goal resume` veya kısa ve açık bir devam mesajı kullanın.

### Aynı session'da başka Goal başlatamıyorum

O session'da bitmemiş canlı bir Goal vardır. Şunlardan birini seçin:

```text
/goal edit <replacement objective>
/goal add <future objective>
/goal clear
```

Ya da paralel çalışma için ikinci bir OpenCode session açın.

## OpenCode Goals'u OpenCode Loop ile kullanmak

İki plugin birlikte kurulabilir:

```bash
npx -y @bybrawe/opencode-loop@latest
npx -y @bybrawe/opencode-goal@latest
```

Önerilen görev ayrımı:

- **OpenCode Goals** — kalıcı `/goal` contracts, host evidence, completion verification, false-completion protection, revision isolation, restart recovery ve ordered Goals.
- **OpenCode Loop** — `/loop`, scheduled command/shell jobs, compaction scheduling ve timer/idle-driven repetition altyapısı.

Aynı OpenCode session'ında aynı iş üzerinde `/goal` ile Loop'un deneysel `/loop-goal` özelliğini birlikte çalıştırmayın. İkisi de autonomous continuation yapabilir ve tur başlatmak için yarışabilir.

Ayrıca aktif `/goal` autonomous olarak devam ederken sürekli prompt üreten bir `/loop ...` işini açık bırakmayın. Goal tamamlanana kadar ayrı session kullanın veya prompt loop'u pause/remove edin.

## Paket ve release kalitesi

npm paketi:

```text
@bybrawe/opencode-goal
```

Repository; deterministic regression tests, adversarial eval'ler, minimum/current OpenCode compatibility lane'leri, real-host lifecycle/semantic/Todo/steering canary'leri, restart recovery testleri, cross-platform package smoke testleri, dedicated server-entry regression coverage ve installer/update/uninstall testleri içerir.

Release geçmişi için [CHANGELOG.md](./CHANGELOG.md), release süreci için [RELEASING.md](./RELEASING.md) dosyasına bakın.

## Kaldırma

`npx` ile kuruldu/güncellendiyse:

```bash
npx -y @bybrawe/opencode-goal@latest --uninstall
```

Installer CLI global kuruluysa:

```bash
opencode-goal --uninstall
npm uninstall -g @bybrawe/opencode-goal
```

Uninstall sırasında proje Goal state'i bilerek **silinmez**:

```text
.opencode/goals/
.opencode/goal-sequences/
.opencode/goal-locks/
```

Project-local Goal state/history'i gerçekten silmek istediğinizde bu dizinleri kendiniz kaldırın.

## Lisans

MIT