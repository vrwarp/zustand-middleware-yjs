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
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }],
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "react-hooks/exhaustive-deps": "warn",

      "@stylistic/padding-line-between-statements": "off",
      "@typescript-eslint/array-type": "off",
      "@typescript-eslint/consistent-type-imports": "off",
      "@typescript-eslint/naming-convention": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-dynamic-delete": "off",
      "@typescript-eslint/no-shadow": "off",
      "@typescript-eslint/no-unnecessary-boolean-literal-compare": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-unnecessary-type-arguments": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-use-before-define": "off",
      "@typescript-eslint/restrict-plus-operands": "off",
      "@typescript-eslint/switch-exhaustiveness-check": "off",
      "arrow-return-style/arrow-return-style": "off",
      "fsecond/no-inline-interfaces": "off",
      "fsecond/prefer-destructured-optionals": "off",
      "jsdoc/convert-to-jsdoc-comments": "off",
      "jsdoc/require-description-complete-sentence": "off",
      "jsdoc/require-hyphen-before-param-description": "off",
      "jsdoc/sort-tags": "off",
      "no-restricted-syntax": "off",
      "simple-import-sort/imports": "off",
      "sonarjs/no-duplicated-branches": "off",
      "tsdoc/syntax": "off",
      "unicorn/consistent-function-scoping": "off",
      "unicorn/explicit-length-check": "off",
      "unicorn/no-array-reduce": "off",
      "unicorn/no-array-sort": "off",
      "unicorn/prefer-spread": "off",
      "unicorn/switch-case-braces": "off",
      "curly": "off",
      "no-else-return": "off",
      "no-negated-condition": "off",
      "no-plusplus": "off",
      "operator-assignment": "off",
      "array-callback-return": "off",
      "object-shorthand": "off",
      "no-restricted-syntax/noDeleteOperator": "off",
      "no-restricted-syntax/noEnums": "off"
    }
  }
];
