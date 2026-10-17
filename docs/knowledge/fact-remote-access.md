# Fact: Remote Access (публичный HTTPS-URL для mobile-web)

Дополнение к `fact-mobile-web.md` для **публичного доступа к локальному web-server** через свой VPS. Mobile-web сервер живёт в main-process Electron на `127.0.0.1:7878`, наружу его пробрасывает reverse SSH tunnel от Mac до VPS, дальше nginx с TLS отдаёт канонический `https://remote-control.f9922.tech` любому устройству где есть интернет. `:8443` остаётся временным compatibility-входом для уже установленных клиентов периода миграции, но новые клиенты используют стандартный HTTPS `443`.

> **Эта же схема переиспользована соседним проектом voice-record** на своём порту:
> `voice.f9922.tech` → тот же VPS nginx → `-R 7888` autossh (`tech.f9922.voice.tunnel.timeweb.plist`)
> → Mac `web-server.js` :7888. Отдельный vhost + Let's Encrypt cert + LaunchAgent, SSE-
> настройки nginx идентичны (`proxy_buffering off`, длинные таймауты). Детали —
> `voice-record/docs/knowledge/fact-mobile-bridge.md`.

## Архитектура

```
Phone (любая сеть: Wi-Fi/4G/через VPN)
  ↓ HTTPS на https://remote-control.f9922.tech/?token=...
VPS 188.225.24.118 (Timeweb, nginx + Let's Encrypt)
  ↓ proxy_pass 127.0.0.1:7878
SSH reverse tunnel (autossh держит постоянно)
  ↓
Mac (Electron, web-server.js слушает 0.0.0.0:7878)
```

**Ключевая особенность:** Mac держит **исходящее** SSH-соединение к VPS, VPS форвардит входящие HTTPS-запросы обратно в этот туннель. Phone про Mac не знает, ходит только на публичный URL.

## Границы владения shared ingress

Timeweb — общая точка завершения TLS, но не общий backend. Custom Terminal владеет `remote-control.f9922.tech` и локальным `:7878`; Voice Record — `voice.f9922.tech` и `:7888`; SC Desktop — `sc.f9922.tech` и `:7898`. Habit Tracker хранит только клиентские домены/token и не дублирует nginx, tunnel или server status. GT Editor остаётся loopback-приложением: телефон получает его файлы через Voice/Terminal API, отдельного публичного vhost у него нет. Root `f9922.tech` принадлежит portfolio и имеет собственные Docker/CI/vhost/TLS-контракты; portfolio deploy не должен затрагивать три API-vhost и reverse sockets.

## Почему не Tailscale (2026-05)

Пробовали Tailscale 1.98 на macOS 26 — `Authentication In Progress` бесконечный retry после успешного login через браузер. Браузер пишет «Login successful», локальный daemon застрял в `Logged out`. Известный bug [tailscale#18676](https://github.com/tailscale/tailscale/issues/18676), [tailscale#17645](https://github.com/tailscale/tailscale/issues/17645) — регрессия начиная с v1.90.2. Даунгрейд на 1.88.4 тоже не помог (sysext не освобождается без полной reboot-чистки). После удаления Tailscale всё сделали через свой VPS.

Бонус-аргумент: при Tailscale на телефоне пришлось бы выбирать между ним и Amnezia (iOS позволяет только один активный VPN), а Amnezia на телефоне постоянно нужна для контента в РФ.

## Почему не cloud-host полностью

См. `fact-mobile-web.md::Почему НЕ cloud-хостинг`. Кратко: `query()` из `@anthropic-ai/claude-agent-sdk` спавнит Claude Code subprocess **локально** с `cwd: project.path`, читает файлы пользователя. На удалённой машине этих файлов нет. Перенос всего сервера на VPS убьёт основную ценность.

## VPS infra (текущая конфигурация)

- **Host:** `188.225.24.118` (Timeweb, Ubuntu 26.04). Это отдельный ingress-VPS: Amnezia VPN остаётся на старом `94.242.59.5`, поэтому запрос к API больше не пытается вернуться на публичный IP того же VPN-сервера.
- **SSH:** root, ключ `~/.ssh/id_ai_agent` в `authorized_keys`.
- **nginx vhost:** `/etc/nginx/sites-enabled/remote-control` → 80 redirect→443, 443 canonical HTTPS, 8443 compatibility HTTPS, proxy_pass `127.0.0.1:7878`.
- **TLS cert:** Let's Encrypt `/etc/letsencrypt/live/remote-control.f9922.tech/`, certbot auto-renew

### nginx-конфиг — нетривиальные настройки

```nginx
# WebSocket upgrade map (для /ws SDK stream)
map $http_upgrade $connection_upgrade { default upgrade; "" close; }

# Custom offline page
error_page 502 503 504 =503 /__offline.html;
location = /__offline.html { root /var/www; internal; }

location / {
    proxy_pass http://127.0.0.1:7878;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_buffering off;          # NDJSON history streams без буферизации
    proxy_request_buffering off;
    proxy_read_timeout 3600s;     # long-lived WS connections
    proxy_send_timeout 3600s;
    proxy_connect_timeout 5s;     # Mac off → быстро в 502 → offline-page
    proxy_next_upstream error timeout http_502 http_503 http_504;
}
```

**`proxy_buffering off` критично** — без этого NDJSON history pipeline (`fact-mobile-web::History pipeline`) теряет прогрессивность, mobile ждёт полный response.

**`proxy_connect_timeout 5s`** — когда Mac закрыт или autossh упал, nginx должен **быстро** отдать 502, чтобы offline-page показалась за несколько секунд, не за минуту default-timeout.

Старый VPN-VPS работал на nginx 1.24 и требовал `listen 443 ssl http2;`. Timeweb использует nginx 1.28: перенесённая форма остаётся валидной, хотя помечена deprecated; при следующей чистке vhost использовать отдельный `http2 on;`. Конфиг всегда проверять через `nginx -t` до reload.

### Почему старый VPS требовал 8443 и был заменён

Шрам 2026-06-14: Terminal и voice одновременно стали недоступны с телефона/мака по обычному `https://*.f9922.tech`, хотя локально Electron был жив. Доказательная цепочка была такой: `curl 127.0.0.1:7878/api/projects` на Mac → 200; `curl http://127.0.0.1:7878/api/projects` с VPS через reverse tunnel → 200; `nc remote-control.f9922.tech 443` снаружи коннектился; но `curl -v https://remote-control.f9922.tech/api/projects` зависал на TLS handshake. `tcpdump` на VPS видел только SYN/SYN-ACK/ACK на `94.242.59.5:443`, без ClientHello/payload от внешнего клиента, при этом payload на 80 приходил. Значит root cause не в Electron, не в iOS-клиенте, не в autossh и не в nginx upstream: ломалась доставка публичного 443 payload до VPS.

Workaround был таким: добавить в vhost'ы дополнительные `8443` listeners и временно перевести клиентов на явный порт. В июле воспроизвёлся второй класс сбоя: iPhone с Amnezia VPN не мог открыть ни Terminal, ни Voice, ни SC Desk, потому что все домены резолвились в публичный IP **того же** VPN-VPS; запросы не доходили даже до nginx, а после отключения VPN сразу появлялись в access-log. Правильный ремонт — отдельный ingress-VPS `188.225.24.118`, стандартный `443` и сохранение `8443` только на время обновления старых клиентов. Бэкапы nginx-конфигов нельзя оставлять в `/etc/nginx/sites-enabled`: nginx читает все файлы там как live config.

### Offline page

`/var/www/__offline.html` (2KB) — статика, рендерится когда proxy не отвечает. Содержит auto-refresh каждые 10с и кнопку «Повторить». Имя `__offline.html` с двумя подчёркиваниями обязательно совпадает с `error_page ... /__offline.html` директивой; раньше файл назывался `remote-control-offline.html` и nginx отдавал 404 пока не переименовали.

## Autossh + LaunchAgent — критичные нюансы

**LaunchAgent:** canonical tunnel — `~/Library/LaunchAgents/tech.f9922.remote-control.tunnel.timeweb.plist` с `KeepAlive=true` + `RunAtLoad=true`. Старый label был bootout после подтверждённого DNS cutover, а plist перенесён в `~/Library/LaunchAgents/disabled-old-vps-20260825/`. На VPN-VPS старые API-vhost и renewal-конфиги лежат в `/root/disabled-api-ingress-20260825/`; порты `7878/7888/7898` там больше не слушаются. Это обратимый аварийный backup, не параллельный production-контур: возвращать его можно только явным restore + `nginx -t` + повторной проверкой DNS.

**Ловушка пустого окружения launchd.** Когда autossh запускается через `launchctl load`, у него нет `HOME`, `PATH`, `SSH_AUTH_SOCK`. SSH не найдёт `~/.ssh/id_*` и не сможет подключиться по ключу — fallback на password, который безголово упадёт. Manual запуск из терминала работает (там shell env унаследован), а launchd-запуск молча умирает с `state = not running, last exit code = (never exited)`.

Лечение: явные переменные и параметры в plist'е:
```xml
<key>EnvironmentVariables</key>
<dict>
    <key>HOME</key><string>/Users/fedor</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>AUTOSSH_GATETIME</key><string>0</string>
    <key>AUTOSSH_POLL</key><string>30</string>
</dict>
<key>ProgramArguments</key>
<array>
    <string>/opt/homebrew/bin/autossh</string>
    ...
    <string>-o</string><string>IdentityFile=/Users/fedor/.ssh/id_ai_agent</string>
    <string>-o</string><string>UserKnownHostsFile=/Users/fedor/.ssh/known_hosts</string>
    <string>-R</string><string>7878:127.0.0.1:7878</string>
    <string>root@188.225.24.118</string>
</array>
```

`AUTOSSH_GATETIME=0` — не ждать «X секунд успешного коннекта прежде чем считать tunnel здоровым», иначе при flaky network autossh тратит время на gate-таймер.

**sshd keepalive на VPS.** Добавлен `ClientAliveInterval=30 / ClientAliveCountMax=6` в `/etc/ssh/sshd_config` — иначе мёртвые reverse-tunnel sockets копятся на VPS пока какой-нибудь NAT не разорвёт TCP.

## Port mapping prod vs dev

- **Prod (port 7878)** — установленный app в `/Applications/Noted Terminal.app`, доступен через публичный URL.
- **Dev (port 7979, NOTED_WEB_PORT)** — `npm run dev` второй инстанс, **только LAN** (туннель прокидывает только 7878).

`StatusBar` chip отражает это: prod показывает `remote-control.f9922.tech` (копирует public URL с токеном), dev — `local:7979` (копирует LAN-URL). `web:open-in-browser` IPC handler в main решает по port'у какой URL открыть. Логика в `StatusBar.tsx::WebChip` + `main.js::web:open-in-browser`.

### Streamer mode

Streamer mode скрывает этот chip с публичным/локальным URL на desktop toolbar и в companion-клиентах, но не меняет сам remote-access pipeline. Autossh, nginx, web-server, SSE и bearer-token продолжают работать; меняется только отображение sensitive endpoint на screen-share/screenshot surface. Если пользователь жалуется «адрес всё ещё видно при стриме», проверяй не туннель, а все UI-поверхности redaction: StatusBar, mobile-web settings, native iOS host label, README/assets screenshots. Переносимый принцип — `methodology/дизайн-принципы.md::Privacy-toggle скрывает sensitive surface`.

Если нужно протестировать dev-сборку с телефона через публичный URL — нужен второй tunnel `-R 7979:127.0.0.1:7979` + второй nginx-vhost `dev.remote-control.f9922.tech` + второй TLS-сертификат. Сейчас не настроено.

## VPN-агностика на стороне Mac

Tunnel — **исходящее** TCP-соединение Mac → VPS:22. Amnezia (и любой другой VPN) пропускает исходящий трафик как обычный, не вмешиваясь. При переключении сети на маке (Wi-Fi → 4G, включение/выключение VPN) autossh видит `ssh_exchange_identification` или `ServerAlive timeout`, ребутает SSH-канал за ~5-30 сек. Public URL `remote-control.f9922.tech` всё это время **не меняется** — phone не замечает что Mac моргнул сетью.

На стороне phone домен должен работать через Amnezia, без VPN и через 4G. Для этого ingress-VPS обязан иметь IP, отличный от VPN exit IP: старый вариант «API и VPN на `94.242.59.5`» создавал hairpin/маршрутный провал до nginx. Детерминированная проверка нового контура — запрос к `188.225.24.118:443` изнутри Amnezia-контейнера получает route-level `401`, а не timeout.

## Что делать когда «не работает»

Диагностический порядок:
1. `tail ~/Library/Logs/remote-control-timeweb-tunnel.log` — autossh-сторона. Если `connect_to 127.0.0.1 port 7878: failed` — Electron не слушает (закрыт или crash).
2. `ps -ef | grep "ssh.*7878:127" | grep -v grep` — есть ли вообще процесс ssh от autossh.
3. `launchctl print gui/501/tech.f9922.remote-control.tunnel.timeweb | grep state` — что launchd думает. Если `state = not running` после bootstrap — см. ловушку пустого env выше.
4. `ssh root@188.225.24.118 'curl -sS -o - -w "\n%{http_code}\n" http://127.0.0.1:7878/api/me'` — тест VPS → Mac через tunnel. `401 unauthorized` подтверждает достижимость для этого малого ответа, но не скорость каталогов/параллельных запросов. `Connection refused` = reverse listener недоступен.
5. `ssh root@188.225.24.118 'tail /var/log/nginx/error.log'` — nginx-side errors (`connect() failed` = backend не отвечает).

Если local/VPS tunnel проходят, но public домен висит, сначала сравни authoritative и recursive DNS с `188.225.24.118`, затем проверяй payload на границе Timeweb. Старый VPN-VPS больше не является API fallback: отсутствие его ports/vhost — ожидаемое состояние, а не причина восстанавливать параллельный tunnel.

Живой SSH-процесс и успешный малый `/api/me` не исключают деградацию его forward.04.10
одновременный authenticated A/B к одному Mac API: штатный канал давал `/projects` timeout,
`/tabs`≈16s, временный новый reverse на loopback-порту VPS — оба≈1s. После точечного
`launchctl kickstart -k gui/501/tech.f9922.remote-control.tunnel.timeweb` обычный public API
отдал каталоги≈2s при неизменном Noted PID/instance. Это восстановление конкретного
соединения, не доказанный механизм его деградации и не повод циклически рестартовать всё.
Для такого A/B временный SSH должен иметь живого владельца процесса; PID после завершения
launcher не доказывает, что туннель сохранился. Удаляй только свой временный forward.
Не передавай bearer в argv/журнал: stdin-конфигурация curl или внутренний HTTP-client.

С 2026-09-13 этот порядок также выполняется автоматически из Voice Record. Нативный iOS-клиент после видимого отказа `/api/projects` или `/tabs` отправляет наблюдение через независимый `voice.f9922.tech`; Voice проверяет процесс Noted, discovery, локальный `7878`, LaunchAgent/autossh/ssh, публичный домен и при необходимости делает один read-only VPS→Mac probe. Итог пишется в `~/Library/Logs/voice-record/voice-record.log` строкой `[TerminalHealth] ... code=<причина>` с тем же mobile request id. Это диагностика, не retry исходного действия.

Важно различать «GUI Noted открыт» и «его HTTP API слушает»: процесс приложения сам по себе не доказывает `7878`. `[WebServer:Health] start-request/listening/bind-conflict/listen-failed/stopped` в `~/Library/Logs/noted-terminal/production.log` фиксирует эту границу. Если `7878` занят и сервер ушёл на следующий порт, discovery и `/api/me.service` показывают resolved port, но production tunnel по-прежнему ведёт на `7878`; автоматический диагноз — `noted-web-port-shifted`.

## Безопасность

- Bearer-token из `~/.noted-terminal/web-token.txt` (24 байта random = 192 бита энтропии) проверяется на каждом REST/WS запросе. Без токена → 401 даже на простой `/api/me`.
- HTTPS-only: 80 редиректит на canonical 443; 8443 сохраняется как compatibility listener с тем же TLS-сертификатом до обновления установленных клиентов. TLS termination на VPS, между nginx и Mac — plaintext HTTP **внутри** SSH-tunnel (тоже шифровано на канальном уровне).
- root SSH с парольным fallback'ом — стандартный для этой VPS-сборки. Меняем при необходимости.
- Visual redaction не является security boundary. Если URL или token попал в публичный скриншот/README/history, недостаточно замазать текущий файл: надо заменить asset и вычистить старые blob'ы из git history (см. `fix-vite-build-traps.md::Часть 4`).
