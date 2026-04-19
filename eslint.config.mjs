import sheriff from 'eslint-config-sheriff';

const sheriffOptions = {
  react: true,
  jest: true,
};

export default [
  ...sheriff(sheriffOptions),
  {
    ignores: [
      "dist/**",
      "**/*.spec.ts",
      "**/*.test.js",
      "**/*.config.ts",
      "**/*.config.js",
      "examples/**",
      "jest.config.ts",
      "rollup.config.ts"
    ]
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }],
      "react-hooks/exhaustive-deps": "warn"
    }
  }
];
