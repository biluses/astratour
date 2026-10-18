import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  outputFileTracingRoot: process.cwd(),
  serverExternalPackages: ["sharp"],
  images: { remotePatterns: [{ protocol: "https", hostname: "lh3.googleusercontent.com" }] },
  webpack(webpackConfig) {
    // Spark inlines its WASM as `new URL("data:...", import.meta.url)`: keep it as runtime code, not an asset import.
    webpackConfig.module.rules.push({ test: /[\\/]@sparkjsdev[\\/]spark[\\/]/, parser: { url: false } });
    return webpackConfig;
  },
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    ] }, { source: "/api/tours/:id/viewer", headers: [
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
    ] }];
  },
};
export default config;
