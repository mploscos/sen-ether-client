import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'artifacts/**',
      'node_modules/**',
      'types/generated/**',
      'lib/protocol/generated.js'
    ]
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node
    },
    rules: {
      ...js.configs.recommended.rules,
      eqeqeq: ['error', 'always'],
      // These legacy modules intentionally retain a few protocol readers and
      // assignments for wire compatibility. Syntax and unsafe globals remain
      // checked without forcing a broad cleanup into the 0.8.0 hardening work.
      'no-loss-of-precision': 'off',
      'no-unused-private-class-members': 'off',
      'no-unused-vars': 'off',
      'no-useless-assignment': 'off'
    }
  },
  {
    files: [
      'lib/bus-*.js',
      'lib/change-batcher.js',
      'lib/client.js',
      'lib/ether-network.js',
      'lib/local-*.js',
      'lib/sen.js',
      'lib/sen-*.js',
      'lib/stl-parser.js',
      'lib/stl-resolver.js'
    ],
    rules: {
      indent: ['error', 4, { SwitchCase: 1 }]
    }
  }
];
