# GOYO Yoga App

Monolito Node.js SSR para reservas fitness por tickets, QR de acceso y operación staff.

## Funciones incluidas (MVP)
- Sitio público visual con animaciones, scroll reveal y paleta personalizada.
- Catálogo de clases y reservas por magic link (sin sesión de cliente).
- Wallet por tipo de clase (1 ticket = 1 reserva compatible).
- Compra de bundles con Stripe Checkout (test) o fallback simulado.
- Confirmación con QR firmado (HMAC) y vista de gestión de booking.
- Portal staff:
  - `ADMIN`: dashboard de negocio y ocupación.
  - `TRAINER`: clases asignadas y roster.
  - `OPS`: check-in con cámara + fallback manual.
- Webhook Stripe con idempotencia.
- Datos dummy para simular el flujo completo.

## Stack
- Node 20 + Express SSR
- Prisma ORM + SQLite (`DATABASE_URL=file:./dev.db`)
- Sessions para staff
- Stripe SDK

## Setup local
```bash
npm install
cp .env.example .env
npm run prisma:generate
npm run db:init
npm run seed
npm run dev
```

Abrir: `http://localhost:3000`

## Credenciales demo staff
- `admin@goyo.local / admin1234`
- `sofia@goyo.local / trainer1234`
- `ops@goyo.local / ops1234`

## Flujos de demo
1. `GET /classes` → ingresar email cliente → magic link.
2. Confirmar booking con ticket.
3. Ver QR en booking.
4. Login ops → `/ops/checkin` → escanear o pegar JSON QR.
5. Login admin/trainer para KPIs y clases.

## Endpoints clave
- `GET /`
- `GET /classes`
- `POST /magic-link/request`
- `GET /booking/start?token=...&occurrenceId=...`
- `POST /bookings`
- `POST /bookings/:id/cancel`
- `POST /checkout/session`
- `POST /webhooks/stripe`
- `POST /staff/login`
- `GET /admin/dashboard`
- `GET /trainer/classes`
- `GET /ops/checkin`
- `POST /ops/checkin/scan`

## Stripe test
Si defines `STRIPE_SECRET_KEY` y `STRIPE_WEBHOOK_SECRET`, usa checkout real y verificación de firma.
Si no, usa fallback simulado para demo de punta a punta.

## CI/CD
- CI: `.github/workflows/ci.yml`
- CD SSH VPS: `.github/workflows/cd-deploy.yml`
- En servidor VPS el contenedor publica en puerto `3100` para evitar colisión con apps existentes.
- Secrets requeridos:
  - `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_PATH`
  - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (si aplica)

## Nota de base de datos
El modelo de datos está normalizado para portar a MySQL en producción; en este MVP se usa SQLite para ejecución rápida y pruebas locales.
