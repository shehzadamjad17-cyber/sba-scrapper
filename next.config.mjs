/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // playwright-core + chromium-min are heavy and Node-only — keep them
    // out of the bundler so they're loaded at runtime
    serverComponentsExternalPackages: [
      "playwright-core",
      "@sparticuz/chromium-min",
      "snoowrap",
      "googleapis",
      "@google/generative-ai",
      "@prisma/client",
      "@prisma/adapter-libsql",
    ],
  },
};
export default nextConfig;
