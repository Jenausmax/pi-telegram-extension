# Дизайн: публикация extension в npm (@jenausmax/pi-telegram-extension)

**Дата:** 2026-07-08
**Статус:** утверждён (Максимом)
**Автор:** Мартин (с Максимом)
**Ключ задачи:** PTE-8

## Контекст и цель

`pi-telegram-extension` — расширение pi (TypeScript, ESM с `.ts`-импортами; pi грузит `.ts`
через jiti). Сейчас пакет `"private": true`, ставится на прод через `pi install git:...@develop`.
Цель — **публиковать его в npm registry** под именем `@jenausmax/pi-telegram-extension`, чтобы
установка была доступна через `pi install npm:@jenausmax/pi-telegram-extension`.

`pi install` поддерживает npm-источник (`pi install npm:@foo/bar` — подтверждено `pi install --help`).

### Ключевое решение: публикуем ИСХОДНИК .ts, без компиляции

Эталон — уже опубликованное pi-расширение **pi-soly** (`~/.pi/agent/npm/node_modules/pi-soly`):
оно публикует **сырой `.ts`** (`"main": "index.ts"`, `pi.extensions: ["./index.ts"]`, нет `dist/`,
нет build-скрипта — только `test`/`typecheck`). pi загружает `.ts` из `node_modules` через jiti.
Значит компиляция в JS не нужна — «сборка» здесь = упаковка и публикация исходника.

### Зафиксированные решения

- **Имя:** `@jenausmax/pi-telegram-extension` (scoped, публичный доступ).
- **Версия первой публикации:** `0.2.0` (бамп от текущего `0.1.0`; остаёмся в 0.x).
- **Публикация:** автоматически через **GitHub Actions** по пушу тега `v*`.
- **Подход:** ship `.ts` source (без компиляции), модель pi-soly.

## Архитектура изменений

### 1. `package.json`

- `name`: `@jenausmax/pi-telegram-extension`
- `version`: `0.2.0`
- удалить `"private": true`
- `"main": "./src/index.ts"` (как `main: index.ts` у pi-soly)
- сохранить `"type": "module"` и `"pi": { "extensions": ["./src/index.ts"] }`
- `"files": ["src", "stt", "bin", "README.md", "LICENSE"]`
- `"peerDependencies": { "@earendil-works/pi-coding-agent": "*" }` (как у pi-soly)
- `"publishConfig": { "access": "public" }` — scoped-пакеты по умолчанию приватные, нужен явный public
- `"keywords": ["pi", "pi-extension", "pi-package", "telegram", "bot", "stt", "whisper", "voice"]`
- `"license": "MIT"`
- `"repository": { "type": "git", "url": "git+https://github.com/Jenausmax/pi-telegram-extension.git" }`
- `"homepage": "https://github.com/Jenausmax/pi-telegram-extension#readme"`
- `"bugs": { "url": "https://github.com/Jenausmax/pi-telegram-extension/issues" }`
- добавить скрипт `"typecheck": "tsc --noEmit"` (локальная проверка; не CI-гейт)

### 2. Исключение тестов из пакета

Тесты (`src/**/*.test.ts`) НЕ должны попадать в публикуемый пакет. Корневой `.npmignore`:

```
**/*.test.ts
```

`files` — whitelist по каталогам; `.npmignore` дополнительно вычищает `*.test.ts` из `src/`.
**Обязательная проверка:** `npm pack --dry-run` показывает содержимое тарбола — убедиться, что
в нём есть `src/*.ts` (рантайм), `stt/stt_server.py`, `stt/requirements.txt`, `README.md`,
`LICENSE`, и НЕТ ни одного `*.test.ts`.

**Критично:** `stt/` (там `stt_server.py` + `requirements.txt`) обязателен в пакете — extension
самоустанавливает STT из этой папки (путь через `import.meta.url`); без неё голос сломается
при npm-установке.

### 3. `LICENSE`

Файл `LICENSE` — MIT, правообладатель Максим (Jenausmax), год 2026. Соответствует `license: "MIT"`.

### 4. CI: `.github/workflows/publish.yml`

- Триггер: `on: push: tags: ['v*']`
- Джоба (ubuntu-latest):
  1. `actions/checkout`
  2. `actions/setup-node` — node 22, `registry-url: https://registry.npmjs.org`
  3. `npm ci`
  4. `npm test` — 85 тестов, обязательный гейт (vitest работает без SDK, как локально)
  5. `npm publish` с `env: NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`
     (`publishConfig.access: public` обеспечивает публичность scoped-пакета)

Typecheck НЕ ставится в CI-гейт: он потребовал бы установки `@earendil-works/pi-coding-agent`
и может вскрыть замаскированные `skipLibCheck` ошибки — это отдельная задача (YAGNI).
Тесты — достаточный гейт: они уже покрывают всю чистую логику и не зависят от SDK.

### 5. Флоу выпуска

1. Ветка `feature/PTE-8-npm-publish` от `develop` → все правки выше → влить в `develop`.
2. `git tag v0.2.0 && git push origin v0.2.0` → GitHub Actions публикует `0.2.0` в npm.
3. (Опционально, отдельно) перевести прод-сервер на `pi install npm:@jenausmax/pi-telegram-extension`
   вместо `git:...@develop`.

## Предусловия (ручные, вне кода)

- **npm-scope `@jenausmax`** существует (npm-аккаунт/орга с этим именем) — за Максимом.
- **npm automation token** с правом publish создан — за Максимом.
- **GitHub Secret `NPM_TOKEN`** добавлен в репозиторий — ✅ ВЫПОЛНЕНО Максимом (2026-07-08).

## Тестирование / проверка

- `npm test` — 85 тестов зелёные (существующая сюита; setup не должен их сломать).
- `npm pack --dry-run` — проверка содержимого тарбола (есть рантайм-.ts + stt/ + README + LICENSE;
  нет `*.test.ts`).
- Первый реальный тег `v0.2.0` → успешный прогон workflow и появление пакета в npm — финальная
  приёмка (после мержа в develop; выполняется с Максимом).

## Вне области (YAGNI)

- Компиляция в JS / `dist/` — не нужна (pi грузит `.ts`).
- Отдельный CI на тесты для каждого push/PR — не просили; здесь только publish-workflow.
- Typecheck как CI-гейт — отдельная задача (требует SDK как devDep).
- Перевод прод-сервера на npm-источник — отдельный шаг после первой публикации.
