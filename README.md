# mine-bot

Проект на Node.js + TypeScript + mineflayer для Minecraft-ботов со строгой DDD-архитектурой.

Все команды ниже предполагают запуск из WSL-терминала в директории `/home/ura2rist/mine-bot`.

## Запуск

1. Установить зависимости:

```bash
npm install
```

2. Создать локальные конфиги из шаблонов:

```bash
cp .env.example .env
cp bots.config.example.json bots.config.json
```

3. Заполнить `.env` общими техническими параметрами.

4. Заполнить `bots.config.json` данными ботов.

5. Запустить проект в dev-режиме:

```bash
npm run dev
```

После входа каждый бот проходит сценарий:

1. подключение к серверу
2. `/register <password> <password>`
3. `/login <password>`
4. отправка сообщения `hi`

## Сборка

Сборка TypeScript в `dist`:

```bash
npm run build
```

Запуск собранной версии:

```bash
npm run start
```

## Схема конфигурации

Приложение поддерживает до 3 ботов в одном процессе.

Разделение конфигов такое:

- `.env` хранит общие технические параметры для всех ботов: `host`, `port`, `version`, `auth`.
- `bots.config.json` хранит только данные конкретных ботов: `role`, `username`, `password`, `rallyPoint`.
- Допустимые роли строго ограничены: `farm`, `trading`, `mine`.
- Каждая роль может быть указана только один раз.
- Пароль обязателен, потому что используется для регистрации и логина через LightAuth.

Пример `.env`:

```dotenv
BOT_HOST=localhost
BOT_PORT=25565
BOT_VERSION=1.20.4
BOT_AUTH=offline
BOTS_CONFIG_PATH=./bots.config.json
BOT_START_DELAY_MS=5000
BOT_LOGIN_TIMEOUT_MS=20000
BOT_SPAWN_TIMEOUT_MS=20000
BOT_CONNECT_RETRY_DELAY_MS=7000
BOT_CONNECT_MAX_RETRIES=2
```

Пример `bots.config.json`:

```json
{
  "bots": [
    {
      "role": "mine",
      "username": "MinerOne",
      "password": "change_me",
      "rallyPoint": {
        "x": 213,
        "y": 64,
        "z": -77
      }
    },
    {
      "role": "farm",
      "username": "FarmerOne",
      "password": "change_me",
      "rallyPoint": {
        "x": 220,
        "y": 64,
        "z": -82
      }
    },
    {
      "role": "trading",
      "username": "TraderOne",
      "password": "change_me",
      "rallyPoint": {
        "x": 205,
        "y": 64,
        "z": -70
      }
    }
  ]
}
```

`rallyPoint` опционален. Если он не указан у конкретного бота, после спавна бот не будет автоматически идти в точку.

## Конфиги ролей

Для будущей настройки поведения добавлены отдельные JSON-файлы:

- `configs/roles/farm.json`
- `configs/roles/trading.json`
- `configs/roles/mine.json`

Структура конфигов такая:

- `farm.json` - список выращиваемых продуктов и количество ячеек под каждый продукт.
- `mine.json` - глубина копания, высота шахты, ширина и длина шахты.
- `trading.json` - список обменов, где задаётся, что игрок отдаёт боту и что бот отдаёт игроку.

Пример `farm.json`:

```json
{
  "products": [
    { "itemId": "wheat", "slotCount": 6 },
    { "itemId": "carrot", "slotCount": 3 }
  ]
}
```

Пример `mine.json`:

```json
{
  "shaft": {
    "targetDepthY": 12,
    "shaftHeight": 3,
    "shaftWidth": 2,
    "shaftLength": 24
  }
}
```

Пример `trading.json`:

```json
{
  "offers": [
    {
      "playerGives": [
        { "itemId": "bread", "amount": 2 }
      ],
      "botGives": [
        { "itemId": "iron_ingot", "amount": 1 }
      ]
    }
  ]
}
```

## Переменные окружения

- `BOT_HOST` - общий адрес Minecraft-сервера для всех ботов.
- `BOT_PORT` - общий порт Minecraft-сервера для всех ботов.
- `BOT_VERSION` - общая версия клиента Minecraft.
- `BOT_AUTH` - общий тип авторизации `offline` или `microsoft`.
- `BOTS_CONFIG_PATH` - путь до файла `bots.config.json`.
- `BOT_LOGIN_TIMEOUT_MS` - сколько ждать сетевой `login` от сервера.
- `BOT_SPAWN_TIMEOUT_MS` - сколько ждать `spawn` после успешной авторизации.
- `BOT_START_DELAY_MS` - пауза между стартом разных ботов, чтобы не упереться в server throttle.
- `BOT_CONNECT_RETRY_DELAY_MS` - пауза перед повторной попыткой после `Connection throttled`.
- `BOT_CONNECT_MAX_RETRIES` - сколько раз повторять попытку подключения при throttle.
- `LIGHTAUTH_REGISTER_COMMAND` - команда регистрации, по умолчанию `/register`.
- `LIGHTAUTH_LOGIN_COMMAND` - команда логина, по умолчанию `/login`.
- `LIGHTAUTH_COMMAND_DELAY_MS` - задержка между auth-командами.
- `LIGHTAUTH_TIMEOUT_MS` - таймаут ожидания ответа от LightAuth.

## Логгер

В проекте есть единый общий логгер для всех ботов. Он:

- пишет `info`, `warn`, `error`
- хранит общую историю записей в памяти
- поддерживает контекст по роли бота
- пишет ошибки подключения, регистрации, логина и таймаутов авторизации

Это зафиксировано в [src/infrastructure/logging/ConsoleLogger.ts](src/infrastructure/logging/ConsoleLogger.ts) и [src/application/shared/ports/Logger.ts](src/application/shared/ports/Logger.ts).

## DDD-структура

```text
src
|-- application
|   |-- bot
|   |   |-- ports
|   |   `-- use-cases
|   `-- shared
|       `-- ports
|-- domain
|   |-- bot
|   |   `-- entities
|   `-- shared
|       `-- errors
|-- infrastructure
|   |-- config
|   |-- logging
|   `-- mineflayer
|-- interfaces
|   `-- cli
`-- main.ts
```

Принцип: `domain` не зависит от инфраструктуры, `application` оркестрирует сценарии, `infrastructure` адаптирует внешние системы, `interfaces` содержит точки входа.
