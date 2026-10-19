import type { NextConfig } from "next";

/**
 * Заголовки безопасности.
 *
 * Осознанно НЕ добавлены `X-Frame-Options` / `frame-ancestors`: терминал
 * демонстрируется во встроенных превью, и запрет фреймов сломал бы их.
 * CSP тоже пока не включён: Next требует `unsafe-inline` для стилей, а
 * неправильно собранный CSP ломает приложение молча и целиком — его стоит
 * добавлять отдельной задачей с проверкой в браузере (см. аудит).
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
];

const nextConfig: NextConfig = {
  // Самодостаточная сборка: позволяет собрать лёгкий образ (Dockerfile) и не
  // тащить node_modules в рантайм-слой.
  output: "standalone",
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
