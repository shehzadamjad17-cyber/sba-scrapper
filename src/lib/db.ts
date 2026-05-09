/**
 * Prisma client singleton. Same pattern as the website (sba-ebsite/src/lib/db.ts).
 * Connects to Turso prod via DATABASE_URL + DATABASE_AUTH_TOKEN.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createPrismaClient() {
  const url = process.env.DATABASE_URL ?? "file:dev.db";
  const authToken = process.env.DATABASE_AUTH_TOKEN;

  const adapter = new PrismaLibSql({ url, authToken });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
