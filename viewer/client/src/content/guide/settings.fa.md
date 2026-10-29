<div dir="rtl">

# مهارت‌ها، افزونه‌ها و هوک‌ها

دو بخشِ Settings می‌گویند یک نشست چه چیزی با خودش به کار می‌برد. **Hooks** هر هوکی را که یک نشست اجرا
می‌کند و جایی را که از آن آمده نشان می‌دهد. **Skills & plugins** (Pro) می‌گوید یک نشست چه چیزی را
می‌تواند صدا بزند، یک نشستِ بی‌ناظر چه چیزی را بار می‌کند، و این پیش از آنکه نشست یک کلمه از فاز را
بخواند چقدر از زمینه‌اش را می‌گیرد.

## Settings ▸ Hooks

این صفحه فقط‌خواندنی است. هر هوکی را که کنسول می‌شناسد فهرست می‌کند، و تنها هوکی که خودش می‌نویسد
هوکِ حضور است که اول می‌آید.

**حضورِ نشست.** این هوکِ سطحِ کاربر به کنسول می‌گوید کِی یک نشستِ Claude در مخزنش شروع می‌شود، یک نوبت
را تمام می‌کند یا پایان می‌یابد. **Install the hook** و **Remove the hook** فایلِ
<span dir="ltr">`~/.claude/settings.json`</span> را ویرایش می‌کنند و <span dir="ltr">`--allow-writes`</span>
می‌خواهند. در فایل ادغام می‌کنند و هرگز جایگزینش نمی‌کنند.

**همه‌ی هوک‌ها.** برای هر منبع یک زبانه هست:

- **Plugin** — افزونه‌ی خودِ کنسول (<span dir="ltr">`hooks/hooks.json`</span>).
- **User** — <span dir="ltr">`settings.json`</span>ِ شما در پوشه‌ی پیکربندیِ کنسول.
- **Project** — <span dir="ltr">`.claude/settings.json`</span> و
  <span dir="ltr">`.claude/settings.local.json`</span>ِ همین مخزن.
- **Run** — تنظیماتی که به هر نشستِ تحتِ نظارت داده می‌شود.

هر هوک رویداد، چیزی که اجرا می‌کند، الگوی تطبیق و مهلتش را می‌گوید. این را هم می‌گوید که وقتی هوک شکست
بخورد چه می‌شود:

- *blocks the call if it fails*: هوک <span dir="ltr">`onFailure: block`</span> دارد، پس هوکی که راه
  نمی‌افتد، از مهلت می‌گذرد یا پاسخِ بی‌معنی می‌دهد، فراخوانی را متوقف می‌کند.
- *carries on if it fails*: پیش‌فرضِ خودِ CLI.

هوک‌های شرطیِ یک اجرا می‌گویند در کدام اجراها هستند. هوکِ <span dir="ltr">`PermissionRequest`</span>ِ
رله فقط در اجرایی است که رله‌اش روشن است.

## Settings ▸ Hooks ▸ hookify rules

وقتی یک اجرا شروع می‌شود، کنسول برای هر دیوار یک فایلِ قاعده در
<span dir="ltr">`.claude/`</span>ِ مخزن می‌نویسد، با نامِ
<span dir="ltr">`hookify.pe-<plan>-<rule>.local.md`</span>. شکلِ فایل همان شکلِ افزونه‌ی hookify است:
front matter با <span dir="ltr">`name`</span>، <span dir="ltr">`enabled`</span>،
<span dir="ltr">`event`</span>، <span dir="ltr">`action`</span> (<span dir="ltr">`warn`</span> یا
<span dir="ltr">`block`</span>) و یک <span dir="ltr">`pattern`</span> یا
<span dir="ltr">`conditions`</span>، و بعد کلماتی که به نشست نشان داده می‌شود. چهار قاعده هست:

- **publish** — push کردن، باز کردن یا ادغامِ یک pull request، ساختنِ یک انتشار، منتشر کردنِ یک بسته.
  زیرِ ردیفِ پیش‌فرضِ <span dir="ltr">`permission.destructive`</span> مسدود می‌کند. وقتی ردیفِ طرح
  استثنایی را اجازه می‌دهد، فقط هشدار می‌دهد و استثناها را نام می‌برد.
- **force-push**، **host** و **secret-files** — فهرستِ هرگز. همیشه مسدود می‌کنند، هرچه طرح بگوید.

فایل‌ها به <span dir="ltr">`.git/info/exclude`</span>ِ خودِ مخزن افزوده می‌شوند، پس درخت را کثیف
نمی‌کنند. کنسول فقط فایل‌های <span dir="ltr">`hookify.pe-`</span>ِ خودش را بازنویسی می‌کند و به قاعده‌ای
از شما دست نمی‌زند. نشستی که hookify را بار می‌کند آن‌ها را می‌خواند، پس یک نفر به‌جای کدِ هوک قاعده را
می‌خواند. هوکِ <span dir="ltr">`PreToolUse`</span>ِ خودِ اجرا و فهرستِ <span dir="ltr">`deny`</span>ِ آن،
چه hookify نصب باشد چه نه، همان دیوارها را اعمال می‌کنند.


</div>
