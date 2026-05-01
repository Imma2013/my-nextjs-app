/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['@sparticuz/chromium', 'puppeteer-core'],
  },
  webpack: (config) => {
    config.resolve.alias.canvas = false;
    return config;
  },
};
module.exports = nextConfig;
