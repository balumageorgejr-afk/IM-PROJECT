const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
    {
        ignores: [
            "node_modules/**",
            "tmp/**",
            "generated/**",
            "coverage/**",
            "client/**",
        ],
    },
    {
        files: ["**/*.js"],
        ...js.configs.recommended,
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: "commonjs",
            globals: globals.node,
        },
        rules: {
            ...js.configs.recommended.rules,
            "no-unused-vars": ["error", { args: "none" }],
            eqeqeq: ["error", "always"],
        },
    },
];
