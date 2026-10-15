import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  {
    // shadcn/ui components are generated (npx shadcn add); keep them as the CLI writes them.
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      'src/renderer/src/components/ui',
      'src/renderer/src/hooks'
    ]
  },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  {
    // Plain-JS build scripts run by node; TS return-type annotations don't apply.
    files: ['scripts/**/*.mjs'],
    rules: { '@typescript-eslint/explicit-function-return-type': 'off' }
  },
  eslintConfigPrettier
)
