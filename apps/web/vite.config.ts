import { defineConfig } from "vite";

const apiProxyTarget = getApiProxyTarget();

export default defineConfig({
  envPrefix: ["VITE_", "WEB_"],
  server: {
    host: "127.0.0.1",
    port: 3000,
    strictPort: true,
    ...(apiProxyTarget
      ? {
          proxy: {
            "/api": {
              target: apiProxyTarget,
              changeOrigin: true
            },
            "/health": {
              target: apiProxyTarget,
              changeOrigin: true
            }
          }
        }
      : {})
  }
});

function getApiProxyTarget(): string | undefined {
  if (process.env.WEB_ENABLE_API_PROXY !== "true") {
    return undefined;
  }

  const target =
    process.env.WEB_API_PROXY_TARGET?.trim() ??
    process.env.WEB_API_BASE_URL?.trim() ??
    "http://127.0.0.1:3001";

  return target === "/" ? "http://127.0.0.1:3001" : target.replace(/\/+$/, "");
}
