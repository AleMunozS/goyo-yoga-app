import { createApp } from './app.js';
import { config } from './config.js';
import { scheduleDatabaseBackups } from './database-backup.js';
import { prisma } from './db.js';

const app = createApp({ prisma });

const server = app.listen(config.port, () => {
  console.log(`tisa-studio listening on ${config.appUrl}`);
  if (!config.simulationMode) scheduleDatabaseBackups({ prisma });
});

const shutdown = async () => {
  server.close();
  await prisma.$disconnect();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
