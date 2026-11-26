import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@klon/core", "@klon/db", "@klon/domain"],
  eslint: { ignoreDuringBuilds: true },
  serverExternalPackages: ["@prisma/client"],
};

export default nextConfig;
