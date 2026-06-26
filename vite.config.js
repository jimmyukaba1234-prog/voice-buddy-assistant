import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function readLocalEnv() {
  const envPath = resolve(process.cwd(), ".env");

  if (!existsSync(envPath)) {
    return {};
  }

  return Object.fromEntries(
    readFileSync(envPath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separatorIndex = line.indexOf("=");
        return [
          line.slice(0, separatorIndex),
          line.slice(separatorIndex + 1).replace(/^['"]|['"]$/g, ""),
        ];
      })
  );
}

// During development the frontend runs on Vite (5173) and the API on Express (3001).
// Proxy /api requests to the backend so the browser can use same-origin fetch("/api/chat").
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ""), ...readLocalEnv() };
  const supabaseUrl = env.VITE_SUPABASE_URL;

  return {
    plugins: [react()],
    define: {
      "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(
        env.VITE_SUPABASE_URL
      ),
      "import.meta.env.VITE_SUPABASE_ANON_KEY": JSON.stringify(
        env.VITE_SUPABASE_ANON_KEY
      ),
    },
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: "http://localhost:3001",
          changeOrigin: true,
        },
        ...(supabaseUrl
          ? {
              "/supabase": {
                target: supabaseUrl,
                changeOrigin: true,
                secure: true,
                rewrite: (path) => path.replace(/^\/supabase/, ""),
              },
            }
          : {}),
      },
    },
  };
});
