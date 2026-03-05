import { createApp } from './app.js';
import { config } from './config.js';
import { prisma } from './db.js';

const app = createApp({ prisma });

const server = app.listen(config.port, () => {
  console.log(`goyo-yoga-app listening on ${config.appUrl}`);
});

const shutdown = async () => {
  server.close();
  await prisma.$disconnect();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
