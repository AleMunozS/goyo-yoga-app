import 'dotenv/config';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { backupDatabase } from '../src/database-backup.js';

const prisma = new PrismaClient();

try {
  const outputPath = await backupDatabase({ prisma });
  console.log(`Respaldo creado: ${path.basename(outputPath)}`);
} finally {
  await prisma.$disconnect();
}
