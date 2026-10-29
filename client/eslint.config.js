import js from "@eslint/js";
import globals from "globals";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
    { ignores: ["node_modules/**", "dist/**", "coverage/**"] },

    // ── Plain JS / JSX files (existing, unchanged) ──────────────────
    {
        files: ["**/*.{js,jsx}"],
        ...js.configs.recommended,
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: "module",
            parserOptions: { ecmaFeatures: { jsx: true } },
            globals: globals.browser,
        },
        rules: {
            ...js.configs.recommended.rules,
            "no-unused-vars": [
                "error",
                { varsIgnorePattern: "^[A-Z]", args: "none" },
            ],
            eqeqeq: ["error", "always"],
        },
    },

    // ── TypeScript / TSX files (new) ─────────────────────────────────
    {
        files: ["**/*.{ts,tsx}"],
        plugins: { "@typescript-eslint": tsPlugin },
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                ecmaVersion: 2024,
                sourceType: "module",
                ecmaFeatures: { jsx: true },
                project: "./tsconfig.json",
            },
            globals: globals.browser,
        },
        rules: {
            ...tsPlugin.configs.recommended.rules,
            "@typescript-eslint/no-unused-vars": [
                "error",
                { varsIgnorePattern: "^[A-Z]", args: "none" },
            ],
            eqeqeq: ["error", "always"],
        },
    },
];
