import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: { "@": new URL("./src", import.meta.url).pathname },
    },
    server: {
        host: "127.0.0.1",
        proxy: {
            "/api": { target: "http://127.0.0.1:5000", changeOrigin: false },
        },
    },
    test: {
        environment: "jsdom",
        setupFiles: ["./src/test-setup.js"],
        css: false,
    },
});
