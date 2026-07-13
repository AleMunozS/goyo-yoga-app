# TISA Studio App

Monolito Node.js SSR para reservaciones pagadas directamente con Stripe Checkout, QR de acceso y operación staff.

## Flujo principal
- Sitio público con agenda, selección de lugares y hold temporal de 10 minutos.
- `POST /api/reservations` crea la reservación en estado `PENDING_PAYMENT`.
- `POST /api/payments/checkout-session` genera un Checkout Session ligado al `reservation_id`.
- `POST /api/stripe/webhook` y `/checkout/success` consumen la misma lógica idempotente de fulfillment.
- El QR se emite solo cuando Stripe confirma `PAID`.
- `ADMIN` y `OPS` pueden generar checkouts compartibles para ventas asistidas desde `/admin/assisted-sales`.

## Stack
- Node 20 + Express SSR
- Prisma ORM + SQLite (`DATABASE_URL=file:./dev.db`)
- Sessions para staff
- Stripe Checkout + webhooks

## Setup local
```bash
npm install
cp .env.example .env
npm run prisma:generate
npm run db:init
npm run dev
```

Abrir: `http://localhost:3000`

## Credenciales demo staff (sólo simulación local)
- `admin@tisa.local / admin1234`
- `sofia@tisa.local / trainer1234`
- `ops@tisa.local / ops1234`

Estas credenciales no son aptas para producción. Antes del go-live, rota todas las cuentas staff y ejecuta `npm run preflight:production`; el comando falla si detecta contraseñas demo o configuración insegura.

## Flujos de demo
1. `GET /classes` → elegir clase y lugares.
2. Completar nombre, correo y teléfono.
3. Redirigir a Stripe Checkout o al fallback simulado.
4. Revisar `/checkout/success` y abrir la reservación desde el manage link.
5. Login ops → `/ops/checkin` → escanear o pegar el payload QR.
6. Login admin/ops → `/admin/assisted-sales` para ventas por WhatsApp.

## Endpoints clave
- `GET /`
- `GET /classes`
- `POST /api/reservations`
- `GET /api/reservations/:id`
- `POST /api/payments/checkout-session`
- `POST /api/payments/payment-link`
- `POST /api/stripe/webhook`
- `GET /checkout/success`
- `GET /booking/manage`
- `GET /admin/dashboard`
- `GET /admin/assisted-sales`
- `GET /trainer/classes`
- `GET /ops/checkin`
- `POST /ops/checkin/scan`

## Stripe
- Define `STRIPE_SECRET_KEY` y un `STRIPE_WEBHOOK_SECRET` nuevo antes de usar webhooks reales.
- No reutilices las llaves expuestas previamente.
- Si no defines Stripe, el proyecto usa un fallback simulado para pruebas punta a punta.

## CI/CD
- CI: `.github/workflows/ci.yml`
- CD SSH VPS: `.github/workflows/cd-deploy.yml`
- Secrets esperados:
  - `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_PATH`
  - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`

## Preflight de producción

Con `SIMULATION_MODE=false` y la configuración real cargada:

```bash
npm run preflight:production
```

El preflight comprueba, sin imprimir secretos:
- URL HTTPS y secretos de sesión/QR no predeterminados.
- Stripe live y webhook configurados.
- SMTP completo para entregar confirmaciones y accesos.
- Ausencia de contraseñas demo en todas las cuentas staff.

El seed demo está bloqueado cuando `SIMULATION_MODE=false` porque reinicia la base de datos.

En producción, la aplicación crea un respaldo SQLite consistente al arrancar y cada 24 horas en `./backups`, conservando 14 copias. También puede ejecutarse manualmente con `npm run backup:database`; `BACKUP_INTERVAL_HOURS`, `BACKUP_RETENTION` y `BACKUP_DIR` permiten ajustar la política.
