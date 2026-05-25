# Tiza Research — Backend

API REST para el dashboard de investigación de inversiones.

## Stack
- Node.js + Express + TypeScript
- SQLite (better-sqlite3) — caché local
- Notion API (`@notionhq/client`) — renderizado de tesis
- uuid para IDs

## Instalación

```bash
npm install
cp .env.example .env
# editar .env con tu NOTION_TOKEN
npm run dev
```

Corre en **http://localhost:3001**

## Base de datos

```bash
# Crear todas las tablas desde cero
npm run db:setup

# Con ruta personalizada
npx tsx scripts/setup-db.ts --path /ruta/custom/tiza.db
```

La DB se crea automáticamente en `data/tiza.db` al arrancar el servidor.

## Variables de entorno

```env
NOTION_TOKEN=secret_xxxxxxxxxx   # token de integración de Notion
PORT=3001
```

## Notion — Configuración

1. Ve a https://www.notion.so/my-integrations
2. Crea integración "Tiza Research"
3. Comparte cada página de tesis con la integración (··· → Connections)

## Endpoints

```
GET    /api/companies                          # lista watchlist
POST   /api/companies                          # añadir empresa
GET    /api/companies/:id                      # detalle empresa
PUT    /api/companies/:id                      # editar empresa
DELETE /api/companies/:id                      # eliminar empresa
POST   /api/companies/:id/sync-notion          # sincronizar desde Notion

GET    /api/companies/:id/earnings             # lista earnings calls
POST   /api/companies/:id/earnings             # añadir earnings call
PUT    /api/companies/:id/earnings/:eid        # editar earnings call
DELETE /api/companies/:id/earnings/:eid        # eliminar earnings call

GET    /api/companies/:id/valuation            # casos de valoración
PUT    /api/companies/:id/valuation/:caseType  # guardar caso (bull/base/bear)

GET    /api/notion/page/:pageId                # obtener página Notion (cacheada)
POST   /api/notion/import                      # importar URL Notion → título + bloques

GET    /api/health
```

## Tablas SQLite

| Tabla | Descripción |
|-------|-------------|
| `companies` | Watchlist con métricas financieras |
| `earnings_calls` | Seguimiento por empresa |
| `valuation_cases` | Casos bull/base/bear por empresa |
| `notion_cache` | Caché de bloques Notion (1h TTL) |
