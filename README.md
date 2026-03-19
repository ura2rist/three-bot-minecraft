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
- `bots.config.json` хранит только данные конкретных ботов: `role`, `username`, `password`.
- Допустимые роли строго ограничены: `farm`, `trading`, `mine`.
- Каждая роль может быть указана только один раз.

Пример `.env`:

```dotenv
BOT_HOST=localhost
BOT_PORT=25565
BOT_VERSION=1.20.4
BOT_AUTH=offline
BOTS_CONFIG_PATH=./bots.config.json
```

Пример `bots.config.json`:

```json
{
  "bots": [
    {
      "role": "mine",
      "username": "MinerOne",
      "password": "change_me"
    },
    {
      "role": "farm",
      "username": "FarmerOne",
      "password": "change_me"
    },
    {
      "role": "trading",
      "username": "TraderOne",
      "password": "change_me"
    }
  ]
}
```

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
