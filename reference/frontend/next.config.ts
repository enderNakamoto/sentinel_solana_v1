import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    // Enable typed routes once frontend pages stabilise (Phase 11+).
  },
};

export default nextConfig;
