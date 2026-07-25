# План: ручная транскрибация и выдача изображений через MCP

## Цель

Добавить в owner/OAuth MCP три команды:

1. `transcribe_source_audio` — вручную транскрибировать ограниченное число уже
   синхронизированных аудио одного явно указанного источника.
2. `list_source_images` — получить ограниченный каталог уже синхронизированных
   изображений одного источника.
3. `get_telegram_images` — получить выбранные изображения из 30-дневного
   server cache либо скачать cache miss из Telegram и вернуть клиенту как MCP
   image content.

Сервер не должен выполнять OCR, vision-анализ или строить embeddings.
Изображение анализирует модель-клиент только после явного вызова
`get_telegram_images`.

## Зафиксированные решения

- Автоматическая транскрибация остаётся ограниченной текущими
  `AUDIO_TRANSCRIPTION_SOURCE_IDS` / `AUDIO_TRANSCRIPTION_SOURCE_TAGS`.
- Ручная транскрибация не добавляет источник в автоматический allowlist и не
  изменяет настройки источника.
- `sync_source` остаётся отдельной операцией. Новые команды не скрывают внутри
  себя синхронизацию Telegram.
- В MongoDB хранятся метаданные изображения и Telegram message reference, но не
  бинарные данные.
- Бинарные файлы хранятся в закрытом server-side cache не более 30 дней.
- Cache заполняется только явно:
  - ручным `sync_source(..., cacheImages=true)` для bounded-набора изображений
    указанного источника;
  - либо `get_telegram_images` для выбранных cache misses.
- Background sync сам по себе не скачивает изображения в cache.
- Срок считается от первоначального сохранения файла и не продлевается при
  List/Get. После истечения срока файл и cache metadata удаляются.
- Новые команды доступны только owner bearer endpoint и OAuth endpoint. На
  no-auth `CHATGPT_MCP_PATH` они не регистрируются.
- Для текущего личного deployment не добавляются новые OAuth permissions:
  - `transcribe_source_audio`: `telegram:read` + `telegram:sync:run`;
  - `list_source_images`, `get_telegram_images`: `telegram:read`.
- Команды закрыты отдельными server-side feature flags, выключенными по
  умолчанию.
- Обрабатываются только enabled sources, дополнительно разрешённые
  `ALLOWED_SOURCE_IDS`, если server ceiling задан.

## Текущая база

- CLI и admin API уже умеют вручную запускать audio transcription с явными
  `sourceIds`.
- Явные `sourceIds` для одного запуска уже переопределяют фоновый список
  источников, не меняя его.
- OAuth MCP сейчас публикует только read-only
  `get_audio_transcription_status`.
- Telegram sync сейчас нормализует только `voice` и `audio`; фотографии и
  image documents не попадают в `tg_messages`.
- MCP сейчас возвращает только JSON в text content blocks.

## Этап 1. Общие ограничения доступа

### 1.1. Проверка источника

Добавить общий service-level guard для media operations:

- источник существует;
- `enabled !== false`;
- источник входит в `ALLOWED_SOURCE_IDS`, если список непустой;
- вызывающий имеет нужные OAuth scopes;
- `sourceId` всегда задаётся точно, без query/wildcard/tag expansion.

Проверка должна происходить до подключения к Telegram и до вызова OpenAI.

### 1.2. Feature flags и лимиты

Добавить конфигурацию:

```text
MCP_MANUAL_TRANSCRIPTION_ENABLED=false
MCP_IMAGE_TOOLS_ENABLED=false
MCP_MANUAL_TRANSCRIPTION_MAX_LIMIT=10
MCP_IMAGE_LIST_MAX_LIMIT=100
MCP_IMAGE_GET_MAX_ITEMS=5
MCP_IMAGE_MAX_FILE_BYTES=10485760
MCP_IMAGE_MAX_TOTAL_BYTES=26214400
MCP_IMAGE_CACHE_MAX_ITEMS_PER_SYNC=100
IMAGE_CACHE_DIR=./tmp/image-cache
IMAGE_CACHE_RETENTION_DAYS=30
IMAGE_CACHE_CLEANUP_INTERVAL_SECONDS=3600
```

Значения из env проходят существующий config loader и получают безопасные
server-side ceiling. Клиент не может поднять лимит параметром команды.
`IMAGE_CACHE_RETENTION_DAYS` валидируется в диапазоне `1..30`, чтобы файл не
оставался на сервере дольше согласованного месяца.

## Этап 2. `transcribe_source_audio`

### 2.1. MCP-контракт

```text
transcribe_source_audio(
  sourceId: string,
  limit?: integer = 1
)
```

Ограничения:

- только один exact `sourceId`;
- `limit`: `1..MCP_MANUAL_TRANSCRIPTION_MAX_LIMIT`;
- обрабатываются только `pending` audio/voice jobs этого источника;
- завершённые транскрипции повторно не обрабатываются;
- failed jobs автоматически не сбрасываются — для этого пока остаётся CLI/admin;
- команда не запускает `sync_source`.

Tool annotations:

```text
readOnlyHint: false
idempotentHint: false
destructiveHint: false
openWorldHint: true
```

Команда не является идемпотентной: повторный вызов может взять следующую
порцию pending jobs.

### 2.2. Результат

Возвращать:

```json
{
  "sourceId": "123",
  "requestedLimit": 5,
  "processedCount": 2,
  "completed": 2,
  "failed": 0,
  "retryScheduled": 0,
  "remainingPending": 3,
  "results": [
    {
      "messageId": 456,
      "status": "done",
      "transcriptLength": 742
    }
  ],
  "hint": null
}
```

Если pending jobs нет, результат успешный с `processedCount: 0` и подсказкой:
сначала вызвать `sync_source`, если требуются свежие или исторические
сообщения.

### 2.3. Wiring и concurrency

- Передать один и тот же transcription runner из `src/server.js` в HTTP admin
  и MCP слой.
- Не создавать независимый worker на каждый MCP вызов в production.
- Использовать существующий `running` guard, чтобы background, admin и MCP
  transcription не выполнялись параллельно.
- Явный `sourceId` передавать в существующий `runOnce({ sourceIds, limit,
  force })`.
- `force` разрешает ручной запуск при выключенном background worker, но не
  обходит отсутствие `OPENAI_API_KEY`, source guard или OAuth.

### 2.4. MCP-регистрация

- Регистрировать команду только при
  `MCP_MANUAL_TRANSCRIPTION_ENABLED=true`.
- Owner bearer endpoint: доступ при наличии `APP_AUTH_TOKEN`.
- OAuth endpoint: требовать `telegram:read telegram:sync:run`.
- No-auth endpoint: никогда не регистрировать.

## Этап 3. Поддержка изображений в Telegram sync

### 3.1. Нормализация media

Расширить `normalizeTelegramMedia`:

- Telegram photo → `media.kind = "photo"`;
- document с `mimeType` из разрешённого image allowlist →
  `media.kind = "image"`;
- voice/audio остаются без изменений.

Сохранять при наличии:

```json
{
  "kind": "photo",
  "mimeType": "image/jpeg",
  "size": 123456,
  "width": 1280,
  "height": 720,
  "fileName": null,
  "photoId": "…",
  "documentId": null,
  "dcId": 2
}
```

`sourceId + messageId` является канонической ссылкой для повторного получения
сообщения из Telegram. `raw.groupedId` уже используется для связи фотографий
альбома.

### 3.2. Правила ingestion

- Media-only image message импортируется, если effective
  `settings.includeMedia=true`.
- Caption остаётся в обычном `text`.
- `transcription.status=pending` создаётся только для `voice`/`audio`, но не
  для изображений.
- При `includeMedia=false` caption может сохраняться, а media metadata
  удаляется, как и сейчас.
- Обычный background sync сохраняет только metadata и не скачивает image
  bytes.
- Явный `sync_source(..., cacheImages=true)` после metadata sync скачивает
  bounded-набор найденных изображений в 30-дневный cache.
- Никаких OCR, vision или других AI-вызовов.

### 3.3. Storage

Добавить методы Memory/Mongo store:

```text
listSourceImages({
  sourceId,
  from,
  to,
  beforeMessageId,
  limit
})

getImageMessages({
  sourceId,
  messageIds
})
```

Добавить Mongo index под выдачу каталога:

```text
{ sourceId: 1, "media.kind": 1, date: -1, messageId: -1 }
```

Запросы фильтруют `media.kind in ["photo", "image"]`. Порядок выдачи
детерминированный: `date desc`, затем `messageId desc`.

### 3.4. 30-дневный image cache

Файлы хранить вне web root:

```text
IMAGE_CACHE_DIR=/srv/tg-mcp/shared/image-cache
```

Использовать отдельную Mongo collection `tg_media_cache`, чтобы очередной
Telegram sync не мог затереть cache state внутри `tg_messages`:

```json
{
  "sourceId": "123",
  "messageId": 456,
  "relativePath": "ab/cd/<opaque-id>.jpg",
  "mimeType": "image/jpeg",
  "size": 123456,
  "sha256": "…",
  "cachedAt": "2026-07-25T10:00:00.000Z",
  "expiresAt": "2026-08-24T10:00:00.000Z"
}
```

Правила:

- путь генерируется сервером из opaque/hash identifiers, без пользовательских
  фрагментов и без возможности path traversal;
- cache root создаётся с закрытыми permissions и не публикуется Apache;
- запись выполняется через temporary file + atomic rename;
- `cachedAt` и `expiresAt` не обновляются при чтении;
- startup sweep и периодический janitor удаляют сначала файл, затем Mongo
  record;
- missing file очищает stale Mongo record;
- janitor также удаляет orphan files, не имеющие Mongo record;
- индекс:
  `{ sourceId: 1, messageId: 1 } unique`;
- обычный индекс по `expiresAt` используется janitor. Mongo TTL index не
  применяется, иначе metadata может исчезнуть раньше удаления файла.

Если Telegram-сообщение удалено после cache write, изображение остаётся
доступно до `expiresAt`. После очистки восстановить его уже нельзя.

### 3.5. Явное заполнение cache через `sync_source`

Расширить существующий MCP-контракт:

```text
sync_source(
  sourceIds: string[],
  limit?: integer,
  backfillDays?: integer,
  cacheImages?: boolean = false,
  imageLimit?: integer
)
```

- `cacheImages=false` сохраняет текущее поведение.
- `cacheImages=true` кеширует изображения только exact sources из этого
  вызова.
- `imageLimit` ограничен
  `MCP_IMAGE_CACHE_MAX_ITEMS_PER_SYNC`; default также равен server ceiling.
- Уже существующий и неистёкший cache entry не скачивается повторно.
- Результат `sync_source` дополняется `imageCache`:
  `requested`, `cached`, `alreadyCached`, `failed`, `expiresAt`.
- Операция использует существующий scope `telegram:sync:run`.

## Этап 4. `list_source_images`

### 4.1. MCP-контракт

```text
list_source_images(
  sourceId: string,
  from?: ISO date/datetime,
  to?: ISO date/datetime,
  beforeMessageId?: integer,
  limit?: integer = 20
)
```

- Один exact enabled source.
- `limit` ограничен `MCP_IMAGE_LIST_MAX_LIMIT`.
- Команда читает только MongoDB и не скачивает Telegram files.
- OAuth scope: `telegram:read`.
- `readOnlyHint: true`.

### 4.2. Результат

Каждая запись содержит:

```json
{
  "sourceId": "123",
  "messageId": 456,
  "date": "2026-07-25T10:00:00.000Z",
  "senderName": "…",
  "text": "caption",
  "transcriptText": "",
  "link": "https://t.me/…",
  "groupedId": "…",
  "media": {
    "kind": "photo",
    "mimeType": "image/jpeg",
    "size": 123456,
    "width": 1280,
    "height": 720,
    "fileName": null,
    "cached": true,
    "cachedAt": "2026-07-25T10:00:00.000Z",
    "expiresAt": "2026-08-24T10:00:00.000Z"
  }
}
```

Также вернуть `nextBeforeMessageId` для следующей страницы и подсказку вызвать
`sync_source`, если каталог пуст или источник давно не синхронизировался.

## Этап 5. `get_telegram_images`

### 5.1. MCP-контракт

```text
get_telegram_images(
  sourceId: string,
  messageIds: integer[]
)
```

- Один exact enabled source.
- `messageIds`: `1..MCP_IMAGE_GET_MAX_ITEMS`.
- Перед чтением cache или Telegram download проверить, что каждый message
  reference существует в MongoDB и имеет `media.kind=photo|image`.
- Неистёкший cache entry читать с диска без Telegram connection.
- Cache miss скачать из Telegram, атомарно сохранить с `expiresAt =
  cachedAt + 30 days`, затем вернуть.
- Один Telegram client на все cache misses batch; обязательный disconnect в
  `finally`.
- Сохранять порядок, запрошенный клиентом.
- OAuth scope: `telegram:read`.
- `readOnlyHint: true`, `openWorldHint: true`.

### 5.2. Возвращаемый MCP content

Для каждого сообщения вернуть:

1. text block с `sourceId`, `messageId`, датой, caption, ссылкой и позицией в
   альбоме;
2. image block:

```json
{
  "type": "image",
  "data": "<base64>",
  "mimeType": "image/jpeg"
}
```

Таким образом модель получает и контекст, и само изображение. Image bytes не
попадают в JSON-логирование или MongoDB, но хранятся в закрытом файловом cache
до фиксированного `expiresAt`.

### 5.3. Размеры и форматы

- MVP allowlist: `image/jpeg`, `image/png`, `image/webp`.
- До download проверять известный Telegram file size.
- После download повторно проверять фактический размер.
- Соблюдать per-file и total response ceilings.
- Перед возвратом cache hit повторно проверять размер и MIME.
- Для Telegram photo выбирать подходящий доступный size под лимит.
- Большой image document без подходящего thumbnail возвращать как
  `too_large`, не загружая полный файл.
- Один плохой элемент не должен отменять весь batch: вернуть per-item error.

## Этап 6. Интеграция с существующим поиском

- В `search_telegram_messages`, `get_message_context` и digest output
  показывать image media reference и `hasImage`, но не встраивать base64.
- Обновить prompt `search_telegram`: если пользователь просит увидеть или
  проанализировать найденные изображения, сначала найти сообщения, затем
  вызвать `get_telegram_images`.
- Для изображений без caption/content search невозможен. Модель может
  просмотреть их только после `list_source_images` и bounded
  `get_telegram_images`.
- Альбом возвращается как несколько сообщений с одинаковым `groupedId`;
  клиент может запросить их одним bounded batch.

## Этап 7. Тесты

### 7.1. Ручная транскрибация

- Команда регистрируется только при feature flag и owner/OAuth access.
- OAuth без `telegram:sync:run` получает challenge.
- No-auth MCP не видит команду.
- Exact source guard отклоняет disabled, unknown и запрещённый ceiling source.
- Ручной source переопределяет только текущий запуск.
- Background allowlist после вызова не изменяется.
- `limit` clamp и default работают.
- Завершённые записи пропускаются; повторный вызов берёт следующую pending.
- Параллельный запуск возвращает `already_running`.
- Нулевой результат содержит полезный sync hint.

### 7.2. Media ingestion и storage

- Нормализация Telegram photo.
- Нормализация JPEG/PNG/WebP document.
- Не-image document игнорируется как image.
- Media-only photo импортируется при `includeMedia=true`.
- Photo не получает transcription state.
- Caption сохраняется и остаётся searchable.
- Mongo/Memory pagination и source/date filters совпадают.
- Albums сохраняют `groupedId`.

### 7.3. Выдача изображений

- List/Get команды скрыты при выключенном flag и на no-auth endpoint.
- Unknown/disabled/forbidden source отклоняется до Telegram connection.
- Non-image messageId и cross-source messageId отклоняются.
- `sync_source` без `cacheImages` не скачивает image bytes.
- `sync_source(cacheImages=true)` кеширует только exact requested sources и
  соблюдает `imageLimit`.
- Неистёкший cache entry не скачивается повторно.
- Cache hit работает без Telegram connection.
- Cache miss скачивается, сохраняется атомарно и получает `expiresAt` ровно
  через 30 дней после `cachedAt`.
- List/Get не продлевают `expiresAt`.
- Janitor удаляет expired file и Mongo record, восстанавливается после
  missing/orphan file state.
- Удалённое из Telegram изображение доступно из cache до истечения срока.
- Batch order сохраняется.
- MIME allowlist, per-file и total byte ceilings соблюдаются.
- Partial batch failure возвращает успешные изображения и ошибки остальных.
- Telegram client всегда отключается.
- MCP result содержит реальные image content blocks и сопровождающий текст.
- Base64/image bytes не выводятся в application logs.

### 7.4. Регрессия

- Полный `npm test`.
- Существующие audio, sync, digest, OAuth и source management tests проходят.
- OpenAPI меняется только если для новых операций сознательно добавляются REST
  аналоги; для MVP REST аналоги не требуются.

## Этап 8. Документация и deployment

### 8.1. Документация

Обновить README:

- новые MCP tools и scopes;
- ручной workflow;
- отсутствие server-side OCR/vision;
- ограничения размера и batch;
- 30-дневный cache lifecycle и поведение deleted Telegram messages;
- privacy note: изображение отправляется MCP-клиенту только после Get.

Примеры:

```text
1. list_sources
2. sync_source(sourceIds=["123"], backfillDays=7)
3. transcribe_source_audio(sourceId="123", limit=5)
```

```text
1. sync_source(
     sourceIds=["123"],
     backfillDays=30,
     cacheImages=true,
     imageLimit=100
   )
2. list_source_images(sourceId="123", limit=20)
3. get_telegram_images(sourceId="123", messageIds=[456, 457])
```

### 8.2. Порядок поставки

Рекомендуемые независимые commits:

1. `Add manual MCP audio transcription`
2. `Store and list Telegram image metadata`
3. `Add 30-day Telegram image cache`
4. `Return cached Telegram images through MCP`
5. `Document and enable owner media tools`

После каждого функционального commit — полный test suite.

### 8.3. Production activation

В `/srv/tg-mcp/shared/.env`:

```text
MCP_MANUAL_TRANSCRIPTION_ENABLED=true
MCP_IMAGE_TOOLS_ENABLED=true
IMAGE_CACHE_DIR=/srv/tg-mcp/shared/image-cache
IMAGE_CACHE_RETENTION_DAYS=30
```

Также выставить согласованные byte/batch ceilings либо оставить безопасные
defaults. Не менять `AUDIO_TRANSCRIPTION_SOURCE_IDS`: Saved Messages остаётся
единственным автоматическим transcription source.

Создать `/srv/tg-mcp/shared/image-cache` с владельцем systemd service user,
permissions `0700` и убедиться, что каталог не попадает под Apache static
serving или release cleanup.

После deploy:

1. проверить health и MCP initialize/list tools;
2. обновить/reconnect ChatGPT app, чтобы перечитать tool catalog;
3. синхронизировать один тестовый enabled chat с `cacheImages=true`;
4. вручную транскрибировать одно pending audio;
5. убедиться, что другие pending audio не обработаны;
6. получить каталог изображений тестового чата;
7. проверить `cachedAt`/`expiresAt` и наличие файлов в закрытом cache;
8. вернуть 1–2 изображения и подтвердить, что ChatGPT их видит;
9. повторить Get и подтвердить cache hit без Telegram download;
10. проверить janitor на искусственно expired test entry;
11. проверить логи на отсутствие base64 и содержимого файлов.

Auth0 API permissions менять не требуется при использовании уже выданных
`telegram:read` и `telegram:sync:run`.

## Критерии готовности

### Ручная транскрибация

- ChatGPT может обработать `N` pending audio только одного явно указанного
  enabled source.
- Вызов не включает источник в background transcription.
- Другие источники и их pending jobs не изменяются.
- Полученный transcript участвует в существующем поиске и digest.

### Изображения

- После sync ChatGPT может перечислить изображения одного источника.
- ChatGPT может запросить выбранные message IDs и получить реальные
  изображения вместе с caption/context.
- Сервер не вызывает OCR/vision API.
- Image bytes хранятся вне MongoDB и web root максимум 30 дней с момента
  cache write; чтение не продлевает срок.
- После expiry janitor удаляет и файл, и cache metadata.
- Неавторизованные, disabled и неразрешённые источники недоступны.
- No-auth MCP endpoint не публикует media tools.

## Явные ограничения MVP

- Нет semantic search по содержимому изображения без caption.
- Нет OCR, image embeddings или автоматического тегирования.
- Нет постоянного архива оригиналов: удалённое из Telegram изображение
  доступно только до expiry уже созданного cache entry.
- Нет неограниченной выдачи всей истории: только пагинация и bounded batches.
- Нет автоматического retry failed transcriptions через MCP.
