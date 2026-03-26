# mine-bot

Тестовый сервер, на котором проверяется поведение ботов: https://t.me/+azgtN5_VjsliOWYy

Обсудить бота: https://t.me/+atEolsASjlI1ZjAy

При поддержке канала: https://t.me/+FGbDjr6PjkI4Mjcy


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

Требование к дальнейшему развитию micro-base сценария: после того как боты сделают себе постели внутри укрытия, следующим шагом нужно сделать для них сундуки.

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
- `configs/roles/trading.json` хранит основной торговый сценарий бота с ролью `trading`.
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

- `farm.json` - список farm-зон: что именно сажать и точки центров ферм с водой.
- `mine.json` - глубина копания, высота шахты, ширина и длина шахты.
- `trading.json` - список обменов, где задаётся, что игрок отдаёт боту и что бот отдаёт игроку.

Пример `farm.json`:

```json
{
  "farms": [
    {
      "itemId": "wheat_seeds",
      "points": [
        { "x": 210, "y": 64, "z": -70 }
      ]
    },
    {
      "itemId": "carrot",
      "points": [
        { "x": 220, "y": 64, "z": -70 }
      ]
    }
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
        { "itemId": "white_wool", "amount": 1 }
      ]
    }
  ]
}
```

## Условности ролей

### trading

- Бот `trading` запускает основной сценарий только после того, как завершены rally, micro-base и выставлен spawn через кровать.
- В конфиге `configs/roles/trading.json` пары читаются по индексам: `playerGives[0] -> botGives[0]`, `playerGives[1] -> botGives[1]` и так далее.
- Бот должен иметь у себя предметы из `botGives`. Если их не хватает, он идёт к ближайшим сундукам у дома и пытается пополнить запас.
- За один проход пополнение идёт максимум до двух стаков каждого товара на обмен.
- Если в сундуках остаток товара закончился, но у бота ещё есть часть этого товара в инвентаре, он не спамит повторными походами к сундукам и торгует тем, что осталось.
- Если свободных слотов становится мало, бот складывает в сундуки всё лишнее, оставляя у себя только торговые товары, оружие и еду.
- В обычном режиме бот стоит снаружи дома примерно в четырёх блоках от двери.
- Когда игрок бросает предметы из `playerGives`, бот считает реально поднятое количество и, когда набирается нужная сумма, выбрасывает соответствующий предмет из `botGives`.
- После выбрасывания предмета за сделку фоновый подбор дропа у бота ставится на паузу на 15 секунд, чтобы он не подбирал свой же торговый дроп обратно.
- Для нормальной работы торгового сценария рядом с домом должны быть сундуки с запасом предметов из `botGives`.

### farm

- Бот `farm` запускает основной сценарий только после того, как завершены rally, micro-base и выставлен spawn через кровать.
- В `configs/roles/farm.json` указывается именно то, что бот сажает: например `wheat_seeds`, `carrot`, `potato`, `beetroot_seeds`.
- Каждая точка в `points` считается центром фермы: это блок воды, а рабочая зона бота это квадрат `7x7` вокруг него по земле, без самого центра.
- Бот подбегает к каждой точке, обходит рабочую зону, ломает только зрелые культуры, не трогает незрелые, пустые клетки при необходимости вспахивает и пересаживает.
- Если у фермера нет мотыги, он крафтит `wooden_hoe`. Если для этого нет дерева, он сначала рубит дерево, затем крафтит палки, доски и саму мотыгу.
- Перед обходом ферм бот ищет нужную культуру во всех сундуках у дома и берёт максимум два стака на посадку.
- Если нужной культуры в сундуках нет, в лог пишется `WARN` вида `Нет нужной культуры в ящиках: <itemId>.`
- После полного обхода всех farm-point зон бот возвращается к тем же сундукам и складывает всё, кроме мотыги, оружия и жареной еды: `cooked_chicken`, `cooked_beef`, `cooked_porkchop`.
- После разгрузки бот забегает внутрь дома через дверь и закрывает её.
- Если бот получил урон, он уходит в дом и ждёт там до дневного времени. Исключение: если рядом появился крипер, бот уходит в дом сразу, не дожидаясь урона.
- После наступления дня бот выходит из shelter только если рядом с домом больше нет угроз.

## Переменные окружения

- `BOT_HOST` - общий адрес Minecraft-сервера для всех ботов.
- `BOT_PORT` - общий порт Minecraft-сервера для всех ботов.
- `BOT_VERSION` - общая версия клиента Minecraft.
- `BOT_AUTH` - общий тип авторизации `offline` или `microsoft`.
- `BOTS_CONFIG_PATH` - путь до файла `bots.config.json`.
- `BOT_LOGIN_TIMEOUT_MS` - сколько ждать сетевой `login` от сервера.
- `BOT_SPAWN_TIMEOUT_MS` - сколько ждать `spawn` после успешной авторизации.
- `BOT_START_DELAY_MS` - пауза между стартом разных ботов, чтобы не упереться в server throttle.
- `BOT_CONFIGURATION_FALLBACK_DELAY_MS` - через сколько миллисекунд попытаться дожать configuration-handshake fallback-пакетами, если сервер не перевёл клиента в `play`.
- `BOT_CONNECT_RETRY_DELAY_MS` - пауза перед повторной попыткой после `Connection throttled`.
- `BOT_CONNECT_MAX_RETRIES` - сколько раз повторять попытку подключения при throttle.
- `LOG_FILE_PATH` - путь до файла общего логгера. По умолчанию `./logs/app.log`.
- `FARM_ROLE_CONFIG_PATH` - путь до файла farm-сценария роли `farm`. По умолчанию `./configs/roles/farm.json`.
- `TRADING_ROLE_CONFIG_PATH` - путь до файла торговых офферов роли `trading`. По умолчанию `./configs/roles/trading.json`.
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

Логи пишутся:

- в консоль процесса
- в файл `logs/app.log` по умолчанию
- путь можно переопределить через `LOG_FILE_PATH`

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

## Tests

Run tests from a WSL terminal inside `/home/ura2rist/mine-bot`:

```bash
npm run test
```

Watch mode:

```bash
npm run test:watch
```

Useful verification commands:

```bash
npm run typecheck
npm run build
```

Important: do not run these commands from a PowerShell session opened at a `\\wsl$\\...` path. Use a WSL shell, otherwise `npm` may fall back to `cmd.exe` and fail on UNC paths.
