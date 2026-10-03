# Публикация инструкций (путь ответов по инструкции)

Операторский скрипт: работает через операторские эндпоинты `leya-api` (`/api/admin/instructions`, `/api/admin/tenant-settings`) с `ADMIN_SECRET`, без прямого SQL. Запускать на сервере, где работает `leya-api`, из папки бэкенда (`.env` с `ADMIN_SECRET` и `PORT`). Другой адрес API — `--api=https://…`.

Любую команду сначала с `--dry-run`: печатает план и ничего не меняет.

## Порядок включения

1. **Миграция 063** (`supabase/migrations/20260930090000_063_instructions_owner_interview.sql`) применена владельцем. Без неё таблицы инструкций нет.
2. **Деплой** `leya-api` с кодом Z–Z3, `pm2 restart leya-api`.
3. **Демо-тексты:**
   ```bash
   npm run instructions:publish -- --demo=home_cook --file=evals/instructions/demo-home-cook.md
   npm run instructions:publish -- --demo=cosmetologist --file=evals/instructions/demo-cosmetologist.md
   ```
4. **Инструкция BizGenie** — без включения, ответы остаются на старом пути:
   ```bash
   npm run instructions:publish -- --tenant=<uuid BizGenie> --file=evals/instructions/bizgenie.md --reply-model=gemini-3.8-flash
   ```
5. **Проверка в симуляторе кабинета** — симулятор отвечает по тому же пути, что и клиентам, поэтому для проверки путь включают и сразу проверяют; при проблеме — откат (ниже).
6. **Включение:**
   ```bash
   npm run instructions:publish -- --tenant=<uuid BizGenie> --file=evals/instructions/bizgenie.md --engine=instruction --reply-model=gemini-3.8-flash
   ```

Повторный запуск с тем же текстом новую версию не создаёт («Текст уже опубликован»). Изменённый текст — новая версия, старая архивируется; текст одной из прежних версий снова активирует её, без новой загрузки.

## Откат

```bash
npm run instructions:publish -- --rollback --tenant=<uuid>
```
Возвращает `reply_engine=legacy`: тенант снова отвечает по старому пути. Версии инструкций не удаляются; включить обратно — шаг 6.
