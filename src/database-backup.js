import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_RETENTION = 14;
const DEFAULT_INTERVAL_HOURS = 24;

const safeInteger = (value, fallback) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const timestamp = (date = new Date()) => date.toISOString().replace(/[:.]/g, '-');

export async function backupDatabase({
  prisma,
  backupDir = process.env.BACKUP_DIR || path.resolve('backups'),
  retention = safeInteger(process.env.BACKUP_RETENTION, DEFAULT_RETENTION),
} = {}) {
  if (!prisma) throw new Error('Se requiere una instancia de Prisma para respaldar la base.');

  await fs.mkdir(backupDir, { recursive: true });
  const outputPath = path.join(backupDir, `tisa-${timestamp()}.db`);
  const escapedPath = outputPath.replaceAll("'", "''");
  await prisma.$executeRawUnsafe(`VACUUM INTO '${escapedPath}'`);
  await fs.chmod(outputPath, 0o600);

  const backups = (await fs.readdir(backupDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^tisa-.*\.db$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();

  await Promise.all(
    backups.slice(retention).map((name) => fs.unlink(path.join(backupDir, name))),
  );

  return outputPath;
}

export function scheduleDatabaseBackups({ prisma } = {}) {
  const intervalHours = safeInteger(process.env.BACKUP_INTERVAL_HOURS, DEFAULT_INTERVAL_HOURS);
  const run = async () => {
    try {
      const outputPath = await backupDatabase({ prisma });
      console.log(`[backup:ok] ${path.basename(outputPath)}`);
    } catch (error) {
      console.error(`[backup:error] ${error?.message || 'No se pudo respaldar la base.'}`);
    }
  };

  void run();
  const timer = setInterval(run, intervalHours * 60 * 60 * 1000);
  timer.unref();
  return timer;
}
