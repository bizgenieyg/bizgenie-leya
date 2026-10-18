# Публикация инструкций (путь ответов по инструкции)

Операторский скрипт: работает через операторские эндпоинты `leya-api` (`/api/admin/instructions`, `/api/admin/tenant-settings`) с `ADMIN_SECRET`, без прямого SQL. Запускать на сервере, где работает `leya-api`, из папки бэкенда (`.env` с `ADMIN_SECRET` и `PORT`). Другой адрес API — `--api=https://…`.

Модель ответов — `gemini-3.8-flash`, запасная на случай сбоя Google — `gpt-6.1-sol` (решение по `docs/evals/2026-10-11-providers.md`). Для запасной в `.env` сервера нужен **`OPENAI_API_KEY`** (после добавления — `pm2 restart leya-api`). Скрипт проверяет модели до любых изменений: префикс `gemini-` / `claude-` / `gpt-` и ключ его провайдера в `.env` (`GEMINI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`); иначе — ошибка, ничего не меняется.

Любую команду сначала с `--dry-run`: печатает план и ничего не меняет.

## Одна схема для всех (Z6)

С Z6 любой бизнес отвечает по ядру + шаблону своего типа сделки + своим фактам, без публикации своей инструкции:
своя активная инструкция (`kind='business'`) → иначе шаблон по операторской `instruction_template` → если она пуста —
шаблон по сфере бизнеса (`src/config/instruction-templates.ts`) → не нашлось — `general`. Системные дефолты:
`reply_engine=instruction`, `reply_model=gemini-3.8-flash`, `reply_fallback_model=gpt-6.1-sol` (без `OPENAI_API_KEY`
запасная просто не используется). Пока ни один шаблон не опубликован, тенант без своей инструкции отвечает по старому пути.

Шаблоны — `evals/instructions/templates/<key>.md`, ключи `service_booking`, `order`, `project`, `b2b`, `general`.

## Порядок выката Z6

0. **Решение по тенантам с трафиком и без своей инструкции** (проверено 18.10): `d8911997` — 385 сообщений за 30 дней,
   сфера не указана, активных фактов нет, своей инструкции нет. После шагов 2–3 он перейдёт на шаблон `general` без фактов.
   До деплоя — либо оставить его на старом пути явно:
   ```bash
   curl -s -X PATCH "http://127.0.0.1:$PORT/api/admin/tenant-settings?tenantId=<uuid d8911997>" -H "Authorization: Bearer $ADMIN_SECRET" -H "Content-Type: application/json" -d '{"reply_engine":"legacy"}'
   ```
   либо заполнить его факты и сферу. BizGenie (`ef795be3`) уже на инструкции — шаблон её не меняет.
1. **Миграция 064** (`supabase/migrations/20261018090000_064_instruction_templates.sql`) применена владельцем (063 уже в базе).
2. **Деплой** `leya-api` (Z6), `pm2 restart leya-api`; при необходимости `OPENAI_API_KEY` в `.env`.
3. **Публикация пяти шаблонов** (сначала `--dry-run`):
   ```bash
   for k in service_booking order project b2b general; do npm run instructions:publish -- --template=$k --file=evals/instructions/templates/$k.md; done
   ```
4. **Проверка в симуляторе на новом тестовом тенанте**: зарегистрировать бизнес в кабинете (например, сфера «мастер маникюра»),
   пройти онбординг до симулятора, задать три предложенных вопроса и свой — ответ должен идти по шаблону (`service_booking`).

Демо-тексты, если ещё не опубликованы:
```bash
npm run instructions:publish -- --demo=home_cook --file=evals/instructions/demo-home-cook.md
npm run instructions:publish -- --demo=cosmetologist --file=evals/instructions/demo-cosmetologist.md
```

## Своя инструкция тенанта

Своя инструкция важнее шаблона. Публикация (сначала `--dry-run`):
```bash
npm run instructions:publish -- --tenant=<uuid> --file=evals/instructions/bizgenie.md --engine=instruction --reply-model=gemini-3.8-flash --fallback-model=gpt-6.1-sol
```
Симулятор кабинета отвечает по тому же пути, что и клиентам.

`--fallback-model=` с пустым значением снимает запасную модель.

Повторный запуск с тем же текстом новую версию не создаёт («Текст уже опубликован»). Изменённый текст — новая версия, старая архивируется; текст одной из прежних версий снова активирует её, без новой загрузки.

## Откат

```bash
npm run instructions:publish -- --rollback --tenant=<uuid>
```
Возвращает `reply_engine=legacy`: тенант снова отвечает по старому пути. Версии инструкций, `reply_model` и `reply_fallback_model` не трогаются; включить обратно — шаг 6.
