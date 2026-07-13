import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { basename, isAbsolute } from 'node:path';
import { chmod, unlink, writeFile } from 'node:fs/promises';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const demoPasswords = ['admin1234', 'trainer1234', 'ops1234'];
const outputPath = String(process.env.CREDENTIAL_OUTPUT || '').trim();

if (process.env.ALLOW_STAFF_CREDENTIAL_ROTATION !== 'true') {
  throw new Error('Define ALLOW_STAFF_CREDENTIAL_ROTATION=true para confirmar la rotación.');
}

if (!outputPath || !isAbsolute(outputPath)) {
  throw new Error('CREDENTIAL_OUTPUT debe ser una ruta absoluta para un archivo nuevo y protegido.');
}

const generatedAt = new Date().toISOString();
let credentialsWritten = false;
let rotationCommitted = false;

try {
  const staff = await prisma.staff_users.findMany({
    select: { id: true, email: true, displayName: true, passwordHash: true, role: true },
    orderBy: { email: 'asc' },
  });

  const accountsToRotate = [];
  for (const account of staff) {
    const usesDemoPassword = (await Promise.all(
      demoPasswords.map((password) => bcrypt.compare(password, account.passwordHash)),
    )).some(Boolean);

    if (usesDemoPassword) {
      const password = `Tisa!${randomBytes(32).toString('base64url')}`;
      accountsToRotate.push({
        ...account,
        password,
        passwordHash: await bcrypt.hash(password, 12),
      });
    }
  }

  if (accountsToRotate.length === 0) {
    console.log('Rotación no requerida: no se detectaron contraseñas demo.');
    process.exitCode = 0;
  } else {
    const credentialDocument = {
      generatedAt,
      purpose: 'TISA production staff credential rotation',
      accounts: accountsToRotate.map(({ email, displayName, role, password }) => ({
        email,
        displayName,
        role,
        password,
      })),
    };

    await writeFile(outputPath, `${JSON.stringify(credentialDocument, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await chmod(outputPath, 0o600);
    credentialsWritten = true;

    await prisma.$transaction(
      accountsToRotate.map(({ id, passwordHash }) =>
        prisma.staff_users.update({ where: { id }, data: { passwordHash } }),
      ),
    );
    rotationCommitted = true;

    const updatedAccounts = await prisma.staff_users.findMany({
      where: { id: { in: accountsToRotate.map(({ id }) => id) } },
      select: { id: true, passwordHash: true },
    });
    if (updatedAccounts.length !== accountsToRotate.length) {
      throw new Error('No fue posible verificar todas las cuentas rotadas.');
    }
    for (const account of updatedAccounts) {
      const stillUsesDemoPassword = (await Promise.all(
        demoPasswords.map((password) => bcrypt.compare(password, account.passwordHash)),
      )).some(Boolean);
      if (stillUsesDemoPassword) throw new Error('La verificación posterior detectó una contraseña demo.');
    }

    console.log(
      `Rotación completada: ${accountsToRotate.length} cuenta(s). Archivo protegido: ${basename(outputPath)}`,
    );
  }
} catch (error) {
  if (credentialsWritten && !rotationCommitted) {
    await unlink(outputPath).catch(() => {});
  }
  throw error;
} finally {
  await prisma.$disconnect();
}
