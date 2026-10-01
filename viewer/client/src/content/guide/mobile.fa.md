<div dir="rtl">

## این کار چه چیزی به شما می‌دهد و چه هزینه‌ای دارد

اجرای بدون‌ناظر برای این است که بتوانید دست از تماشایش بردارید. این فقط وقتی به کار می‌آید که اجرا هنوز
بتواند به شما برسد — اجرایی که روی یک تأیید متوقف شده باشد منتظر می‌ماند تا کسی جواب بدهد، و اگر کنسول
فقط از همان صندلیِ جلوی آن در دسترس باشد، هر توقف تا وقتی طول می‌کشد که دوباره پشتِ آن بنشینید.

حدود ده دقیقه، بیشترش کلیک‌کردن روی سوییچ‌ها. **هیچ‌کدام از این کارها چیزی را روی اینترنتِ عمومی قرار
نمی‌دهد.**

<div dir="ltr">

```
  your phone, anywhere                       your machine
  ────────────────────                       ────────────
  https://your-machine.your-tailnet.ts.net
        │
        │  encrypted, private network, no open ports
        ▼
  tailscaled ──────────── sets Tailscale-User-Login: you@example.com
        │
        │  http://127.0.0.1:4123
        ▼
  Phase Console ───────── still bound to loopback. It always was.
```

</div>

> **⚠️ هرگز از <span dir="ltr">`--host 0.0.0.0`</span> استفاده نکنید.** هدرِ هویت تمامِ ماجرای احرازِ هویت
> است، و فقط *به این دلیل* ارزش دارد که کنسول روی loopback می‌ماند. اگر کنسول روی یک اینترفیسِ شبکه گوش می‌داد،
> هر کسی که به آن می‌رسید می‌توانست خودش همان هدر را بفرستد. <span dir="ltr">`--remote`</span> عمداً bind را
> بازتر نمی‌کند، و راهنمای خودِ Tailscale هم همین را می‌گوید: سرویس فقط روی localhost گوش بدهد.

به یک حساب [Tailscale](https://tailscale.com) نیاز دارید. سطحِ رایگانِ آن برای این کار به‌راحتی کافی است.

## سه چیز را برای tailnet خودتان روشن کنید

هر سه به‌صورتِ پیش‌فرض خاموش‌اند و هر سه لازم‌اند. دو مورد اول در صفحه‌ی DNS در ادمین‌کنسولِ Tailscale هستند.

1. **Enable MagicDNS** — همان چیزی که باعث می‌شود `your-machine.your-tailnet.ts.net` برای دستگاه‌های خودتان
   resolve شود. بدونِ آن باید یک نشانیِ IP تایپ می‌کردید، و یک نشانیِ IP نمی‌تواند گواهی داشته باشد.
2. **Enable HTTPS Certificates** — بعد از آن Tailscale برای همان نام یک گواهیِ واقعی و مورد اعتمادِ عمومی
   صادر می‌کند. HTTPS به MagicDNS *نیاز دارد*، پس به همین ترتیب انجامشان بدهید.
3. **Enable Serve** — سوییچی نیست که از قبل دنبالش بگردید. اولین باری که `tailscale serve` را روی یک
   tailnet اجرا می‌کنید که هرگز Serve را به کار نبرده، دستور یک لینکِ تأیید چاپ می‌کند و به‌جای خروج
   **صبر می‌کند**. لینک را باز کنید و تأیید کنید؛ خودش ادامه می‌دهد.

فعال‌کردنِ گواهی‌ها *نامِ* ماشین شما را در لاگِ عمومیِ Certificate Transparency منتشر می‌کند. خودِ ماشین در
دسترس نمی‌شود — هیچ‌چیز در اینجا پورتی باز نمی‌کند.

تا در ادمین‌کنسول هستید، در صفحه‌ی Machines برای همین ماشین **disable key expiry** را انتخاب کنید. کلیدهای
node به‌صورتِ پیش‌فرض منقضی می‌شوند، و وقتی یکی منقضی شود، دسترسیِ راه‌دور بی‌هیچ هشدار و بی‌هیچ علتِ روشنی
قطع می‌شود.

## گوشی‌تان را روی همان tailnet بیاورید

اپِ Tailscale را نصب کنید، با همان حساب وارد شوید، و — که به‌راحتی از قلم می‌افتد — مطمئن شوید در
تنظیماتِ اپ **"Use Tailscale DNS" روی ON است**. همین است که به گوشی اجازه می‌دهد نامِ
<span dir="ltr">`.ts.net`</span> را resolve کند؛ بدونِ آن نام اصلاً بارگذاری نمی‌شود.

روی ماشینتان `tailscale status` را اجرا کنید؛ گوشی باید در فهرست باشد.

## به کنسول بگویید چه کسی اجازه‌ی ورود دارد

<div dir="ltr">

```bash
./start --root ~/code/your-repo --allow-writes --allow-run --allow-agent \
        --remote your-machine.your-tailnet.ts.net \
        --remote-user you@example.com
```

</div>

| پرچم | معنی |
|---|---|
| <span dir="ltr">`--remote <host>`</span> | کنسول به این hostname هم جواب می‌دهد، که پشتِ یک پراکسیِ احرازِ هویت‌کننده قرار دارد. قابل تکرار. بررسیِ سخت‌گیرانه‌ی `Host` را روشن می‌کند. |
| <span dir="ltr">`--remote-user <login>`</span> | یک login که اجازه دارد از آن راه وارد شود. قابل تکرار، یا `PHASE_CONSOLE_REMOTE_USERS` به‌صورتِ فهرستی که با ویرگول جدا شده. برای <span dir="ltr">`--remote`</span> **الزامی** است. |

نامِ واقعیِ MagicDNS خودتان را بگذارید — `tailscale status --json` آن را به‌صورتِ `Self.DNSName` چاپ
می‌کند — و همان login که با آن وارد شده‌اید. <span dir="ltr">`--allow-agent`</span> اختیاری است؛ همان است که
نشست‌های تعاملی در صفحه‌ی **Sessions** و ویزاردِ *New plan with AI* را از روی گوشی کار می‌اندازد.

<span dir="ltr">`--remote`</span> بدونِ <span dir="ltr">`--remote-user`</span> **بالا نمی‌آید**. شروعِ بدونِ
فهرستِ مجاز کاملاً درست به نظر می‌رسد و بی‌صدا همه‌ی کسانی را که در شبکه‌ی شما هستند راه می‌دهد؛ برای همین
این یک خطاست، نه یک هشدار.


## پراکسی را جلوی آن بگذارید

<div dir="ltr">

```bash
tailscale serve --bg --https=443 http://127.0.0.1:4123
tailscale serve status
```

</div>

**اگر می‌خواهید این تنظیم بماند، <span dir="ltr">`--bg`</span> اختیاری نیست.** با آن، Serve بعد از ری‌بوت و
بعد از `tailscale down` / `tailscale up` هم باقی می‌ماند؛ بدونِ آن، Serve فقط به اندازه‌ی عمرِ همان دستورِ
پیش‌زمینه زنده است. برای برگرداندنش:
<span dir="ltr">`tailscale serve --https=443 http://127.0.0.1:4123 off`</span>.


حالا <span dir="ltr">`https://your-machine.your-tailnet.ts.net/`</span> را روی گوشی باز کنید. نمادِ قفل،
بدونِ هشدار، بدونِ شماره‌ی پورت.

## آن را روی Home Screen نصب کنید

در Safari: **Share ▸ Add to Home Screen**.

این تزئینی نیست. در iOS، **اعلان‌های وب فقط برای سایتی وجود دارند که روی Home Screen نصب شده باشد** — در یک
تبِ معمولیِ Safari حتی نمی‌شود مجوزش را درخواست کرد. چون اعلان تمامِ دلیلِ در دسترس بودن است، نصب بخشی از
راه‌اندازی است، نه یک کارِ تشریفاتی.

Android به هیچ‌کدام از این‌ها نیاز ندارد — اعلان‌ها در یک تبِ معمولیِ HTTPS کار می‌کنند — اما نصب‌کردن باز هم
پنجره‌ی تمیزتری به شما می‌دهد.

## push را روشن کنید و انتخاب کنید چه بفرستد

**Notifications ▸ Devices** دو سوییچ دارد، و تفاوتشان تمامِ ماجراست:

| | چیست | کِی اعلان می‌دهد |
|---|---|---|
| **In this tab** (در این تب) | Notification API، که خودِ صفحه آن را راه می‌اندازد. | فقط تا وقتی تبی جایی باز است. |
| **On this device** (روی این دستگاه) | یک اشتراکِ push، که Apple، Google یا Mozilla آن را به یک service worker می‌رسانند. | با کنسولِ بسته، گوشیِ قفل‌شده، لپ‌تاپِ در خواب. |

زیرِ *On this device* دکمه‌ی **Turn on** را بزنید، بعد **Send a test** را — این آزمایش از خودِ سرویسِ push
واقعی می‌رود و برمی‌گردد، پس دیدنِ یک اعلان کلِ زنجیره را ثابت می‌کند، نه فقط آخرین قدمِ آن را.

روی لپ‌تاپ هم انجامش بدهید: <span dir="ltr">`http://127.0.0.1`</span> یک secure context حساب می‌شود، پس همان
دکمه آنجا بدونِ هیچ HTTPSای کار می‌کند، و هر مرورگر اشتراک و انتخاب‌های خودش را دارد.

مجوز هرگز هنگامِ بارگذاری خواسته نمی‌شود: صفحه‌ای که همان لحظه‌ی باز شدن درخواست می‌کند بی‌فکر رد می‌شود،
و این رد دائمی است. payloadها با کلیدی رمز می‌شوند که فقط مرورگر شما دارد (RFC 8291)، پس سرویسِ push اعلانی
درباره‌ی طرح‌های شما را جابه‌جا می‌کند، بی‌آنکه بتواند بخواندش.


## بی‌آنکه چیزی را باز کنید جواب بدهید

بعضی اعلان‌ها دکمه دارند — **Allow** (اجازه) و **Deny** (رد) روی کارتِ مجوز، **Approve** (تأیید) روی گیتی که
یک آدم می‌تواند بازش کند. زدنِ یکی‌شان جواب را می‌دهد و یک رسید نشان می‌دهد؛ هیچ‌چیز باز نمی‌شود. Android و
دسکتاپ آن‌ها را رندر می‌کنند، iOS اعلان را بدونِ آن‌ها نشان می‌دهد، و لمسِ اعلان به
<span dir="ltr">`#/approve`</span> می‌رسد.

یک دکمه می‌تواند به یک پرسش **جواب بدهد** و هرگز نمی‌تواند **کاری را شروع کند یا بکُشد**: Recover، Nudge،
Freeze و Stop عمداً از روی اعلان پیشنهاد نمی‌شوند، چون یک ضربه‌ی اشتباه روی صفحه‌ی قفل نباید بتواند نشستی را
به راه بیندازد. payload هیچ نشانی هم حمل نمی‌کند — فقط یک توکنِ امضاشده که یک مورد و فعل‌های پیشنهادشده برای
آن را نام می‌برد، با اعتبارِ دوازده ساعت و فقط یک بار قابل‌مصرف. هر چیزِ منقضی‌شده، قبلاً پاسخ‌داده‌شده، یا
در این فاصله برطرف‌شده، به‌جایش کنسول را باز می‌کند.

## ‎`#/approve` — صفِ گوشی

یک صفحه، یک ستون، و چیزی جز آنچه به شما نیاز دارد و از همین‌جا می‌شود جوابش را داد. بوکمارکش کنید؛ هر push به
آن لینک می‌دهد.

یک مورد فقط وقتی ظاهر می‌شود که این کنسول بتواند رویش اقدام کند — چاره‌ای که پشتِ قابلیتی است که این کنسول
با آن شروع نشده، ته صفحه شمرده می‌شود و به‌شکلِ دکمه‌ی مرده کشیده نمی‌شود، و *Session waiting on you* اصلاً
ظاهر نمی‌شود، چون آن نشست در پرامپتِ ترمینالِ خودش ایستاده و هیچ‌چیز اینجا نمی‌تواند به‌جایش جواب بدهد.

هر جا که حرف‌های شما می‌تواند جایی برود — شواهد روی یک گیت، دلیل روی یک کارتِ مجوز — کارت یک فیلد برایش
دارد، با یک **میکروفون** کنارش در مرورگرهایی که آن را دارند. دیکته فیلد را پر می‌کند؛ هرگز دکمه را
نمی‌زند.

## هشدار بدونِ هیچ مرورگری

push هنوز جایی به یک مرورگر نیاز دارد، حتی یک مرورگرِ بسته. برای ماشینی که چنین نیست — یک سرورِ headless، یک
پیجر، یک کانالِ چت — `PHASE_CONSOLE_NOTIFY` را به یک اسکریپت اشاره بدهید. هر وقت اجرایی به یک آدم نیاز داشته
باشد، این اسکریپت به‌شکلِ <span dir="ltr">`your-script "<title>" "<body>"`</span> اجرا می‌شود:

<div dir="ltr">

```bash
#!/bin/sh
# ~/.local/bin/phase-notify
curl -s -H "Title: $1" -d "$2" https://ntfy.sh/your-private-topic-name >/dev/null
```

</div>

<div dir="ltr">

```bash
chmod +x ~/.local/bin/phase-notify
export PHASE_CONSOLE_NOTIFY=~/.local/bin/phase-notify
```

</div>


> **این کار نامِ طرح‌ها و جزئیاتِ تأییدها را به هر سرویسی که انتخاب کنید می‌فرستد.** یک نامِ topic انتخاب کنید
> که هیچ‌کس حدسش نزند، و اگر کار حساس است، خودتان میزبانی کنید یا اسکریپت را به جایی اشاره بدهید که زیرِ
> کنترلِ شماست. متغیر عمداً فقط از محیط (environment) خوانده می‌شود — هیچ‌چیزی که از یک صفحه‌ی وب در دسترس
> باشد نمی‌تواند انتخاب کند کدام دستور اجرا شود.

## آنچه واقعاً اعمال می‌شود

به‌محضِ اینکه یک hostname نام ببرید، بررسیِ سخت‌گیرانه‌ی `Host` روشن می‌شود و دقیقاً دو نوع درخواست سرو
می‌شود.

| درخواست | حکم |
|---|---|
| `Host` از نوعِ loopback، بدونِ هدرِ هویت | **سرو می‌شود.** شما، پشتِ همین ماشین — مثلِ قبل، بدونِ تغییر. |
| hostname شما در <span dir="ltr">`--remote`</span> + یک loginِ مجاز | **سرو می‌شود.** شما، از راهِ پراکسی. |
| hostname شما در <span dir="ltr">`--remote`</span>، بدونِ هدرِ هویت | **403.** چیزی بی‌آنکه از پراکسی بگذرد به کنسول رسیده است. |
| hostname شما در <span dir="ltr">`--remote`</span>، یک login که در فهرست نیست | **403.** یک نفرِ دیگر در شبکه‌ی شما. |
| هر `Host` دیگر | **421.** این همان چیزی است که یک صفحه‌ی DNS-rebinding با آن می‌آید. |

## راندنِ یک نشست از روی گوشی

وقتی کنسول روی گوشی‌تان باشد، صفحه‌ی **Sessions** — که هم یک `claude` تعاملی و هم یک شلِ ساده در آن زندگی
می‌کنند — برای انگشتِ شست ساخته شده است:

- **نوارِ کلید** زیرِ ترمینال یک شبکه‌ی ثابتِ دوردیفه است — <span dir="ltr">`Esc` `Tab` `⇧Tab` `^C` `Ctrl`</span>
  بالای <span dir="ltr">`↑` `↓` `←` `→` `Paste`</span> — و هرگز اسکرول نمی‌شود: همه‌ی کلیدها روی صفحه‌اند،
  کشیدنِ انگشت رویش چیزی تایپ نمی‌کند، یک ضربه دقیقاً یک کلید می‌فرستد، و ترمینال بی‌آنکه جابه‌جا شود فوکوس
  را نگه می‌دارد. `Ctrl` چسبنده (sticky) است: آن را بزنید، بعد یک حرف از کیبورد. کلیدِ
  <span dir="ltr">`⋯`</span> به صفحه‌ی دوم می‌برد — <span dir="ltr">`Home` `End` `PgUp` `PgDn` `Del`</span>،
  بعد <span dir="ltr">`A−`</span> / <span dir="ltr">`A+`</span> (اندازه‌ی قلمِ ترمینال؛ صفحه هنوز با دو انگشت
  زوم می‌شود، اما معمولاً قلمِ بزرگ‌تر همان چیزی است که می‌خواستید) و
  <span dir="ltr">`^L` `^D` `^R`</span>.
- **کادرِ پیام** بالای نوارِ کلید، در نشست‌های agent، جایی است که پیام به Claude را در آن تایپ می‌کنید: یک
  خط، با تصحیحِ خودکار و بزرگ‌سازیِ حروف خاموش، و **Send** آن را همراه با Enter می‌نویسد. تایپِ مستقیم در
  ترمینال هنوز کار می‌کند؛ کادرِ پیام برای جمله‌هاست.
- **اندازه و اتصالِ دوباره خودکار سامان می‌گیرند.** pty با همان اندازه‌ای ساخته می‌شود که صفحه‌ی شما واقعاً
  دارد، و وقتی کیبورد باز می‌شود یا گوشی می‌چرخد یک بار به آن خبر داده می‌شود، نه پانزده بار. اتصالی که قطع
  شود — قفل‌شدنِ گوشی، اپ در پس‌زمینه — خودش برمی‌گردد، و در این فاصله *Reconnecting… (n)* نشان داده می‌شود؛
  کنسول نشست و scrollbackِ آن را نگه می‌دارد، پس تا وقتی سوکت نیست چیزی گم نمی‌شود.
- **فهرستِ نشست‌ها** نواری است بالای ترمینال: نشستِ باز و یک فلش. آن را بزنید تا همه‌ی نشست‌ها،
  Freeze / Continue / Stop، ساعت، و *New plan with AI* را ببینید.
- در حالتِ عمودی ترمینال ۸۰ ستون را نگه می‌دارد و زیرِ انگشت به پهلو جابه‌جا می‌شود؛ در حالتِ افقی ستون‌ها
  یک‌جا جا می‌شوند.

## بگذارید Claude Code همه‌ی آن را انجام دهد

اگر ترجیح می‌دهید گام‌های بالا را دستی اجرا نکنید، این را paste کنید و به پرسش‌هایش جواب بدهید:

<div dir="ltr">

```
Make my Phase Console reachable from my phone over Tailscale.

1. Check the ground first and stop if any of it is missing:
     tailscale status            is it installed, and signed in?
     tailscale status --json     read MagicDNSSuffix, CurrentTailnet.MagicDNSEnabled,
                                 Self.DNSName and User for my login
   If MagicDNS is off, or HTTPS certificates are not enabled for the tailnet,
   tell me to turn both on in the Tailscale admin console (DNS → MagicDNS, and
   DNS → HTTPS Certificates) — they are tailnet-wide settings you cannot set
   from here — then wait for me.
2. Publish the console on the tailnet, on 443, still bound to loopback:
     tailscale serve --bg --https=443 http://127.0.0.1:4123
   Use my real port if it is not 4123. Confirm with: tailscale serve status
3. Restart the console so it answers to that hostname, keeping every flag it
   already has — read them from how it is running right now, never guess:
     bash <skill>/start --root <repo> [existing flags] \
       --remote <Self.DNSName without the trailing dot> \
       --remote-user <my login>
   Without --remote the console refuses proxied requests with a 421, so the URL
   would resolve and then fail. With it, the console still listens only on
   loopback: Tailscale terminates TLS, proves who is calling, and forwards.
4. Print the https URL and confirm it answers from this machine.
5. Then tell me what to do on each device I want to use:
     - install Tailscale and sign into the SAME tailnet
     - turn on MagicDNS / "Use Tailscale DNS"
     - open the URL
     - on iOS, add it to the Home Screen — notifications only work from there
   Only devices on my tailnet, signed in as an allowed user, can reach it.

Never widen --host to expose the console on a network interface. The identity
header is trustworthy only because nothing but the proxy can reach the port.
```

</div>


</div>
