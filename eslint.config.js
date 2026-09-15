import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Fixtures are deliberately plain .mjs stand-ins for the real CLIs.
  { ignores: ["dist/**", "node_modules/**", "coverage/**", "test/fixtures/**"] },
  js.configs.recommended,
  // Type-aware linting: catches floating promises and unsafe `any` flow, which
  // is most of what can actually go wrong when shelling out to the CLIs.
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": "off",
    },
  },
  {
    files: ["**/*.test.ts"],
    rules: { "@typescript-eslint/no-unsafe-assignment": "off" },
  },
);
