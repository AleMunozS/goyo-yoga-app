import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const failures = [];

const value = (name) => String(process.env[name] || '').trim();
const hasStrongSecret = (name, rejectedValues) => {
  const current = value(name);
  return current.length >= 32 && !rejectedValues.includes(current);
};

if (value('SIMULATION_MODE') !== 'false') failures.push('SIMULATION_MODE debe ser false.');
if (!value('APP_URL').startsWith('https://')) failures.push('APP_URL debe usar HTTPS.');
if (!hasStrongSecret('SESSION_SECRET', ['change-me', 'dev-session-secret'])) {
  failures.push('SESSION_SECRET debe tener al menos 32 caracteres y no usar el valor demo.');
}
if (!hasStrongSecret('QR_SECRET', ['change-me-qr', 'local-qr-secret'])) {
  failures.push('QR_SECRET debe tener al menos 32 caracteres y no usar el valor demo.');
}
if (!value('STRIPE_SECRET_KEY').startsWith('sk_live_')) failures.push('Stripe debe usar una llave live.');
if (!value('STRIPE_WEBHOOK_SECRET').startsWith('whsec_')) failures.push('Falta el secreto del webhook de Stripe.');
if (!value('SMTP_HOST') || !value('SMTP_USER') || !value('SMTP_PASS') || !value('SMTP_FROM')) {
  failures.push('La configuración SMTP está incompleta.');
}

const demoPasswords = ['admin1234', 'trainer1234', 'ops1234'];

try {
  const staff = await prisma.staff_users.findMany({ select: { email: true, passwordHash: true } });
  if (staff.length === 0) failures.push('No existen cuentas staff.');
  for (const account of staff) {
    const usesDemoPassword = (await Promise.all(
      demoPasswords.map((password) => bcrypt.compare(password, account.passwordHash)),
    )).some(Boolean);
    if (usesDemoPassword) failures.push(`La cuenta ${account.email} todavía usa una contraseña demo.`);
  }
} catch {
  failures.push('No fue posible validar las cuentas staff en la base de datos.');
} finally {
  await prisma.$disconnect();
}

if (failures.length > 0) {
  console.error('Preflight de producción: BLOQUEADO');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Preflight de producción: OK');
