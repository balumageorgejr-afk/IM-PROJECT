import js from "@eslint/js";
import globals from "globals";
export default [
    { ignores: ["node_modules/**", "dist/**", "coverage/**"] },
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
];
