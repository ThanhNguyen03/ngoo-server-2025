import alias from '@rollup/plugin-alias';
import json from '@rollup/plugin-json';
import typescript from '@rollup/plugin-typescript';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default {
  input: ['src/index.ts'],
  output: {
    dir: 'build',
    preserveModules: false, // If will build to a single index.js file if it 'false'
    sourcemap: true,
  },
  plugins: [
    alias({
      entries: [
        { find: '@helper', replacement: path.resolve(__dirname, 'src/helper') },
        { find: '@service', replacement: path.resolve(__dirname, 'src/services') },
        { find: '@apollo-api', replacement: path.resolve(__dirname, 'src/apollo') },
        { find: '@model', replacement: path.resolve(__dirname, 'src/model') },
        { find: '@lib', replacement: path.resolve(__dirname, 'src/lib') },
        { find: '@generated/graphql', replacement: path.resolve(__dirname, 'src/apollo/types.generated') },
      ],
    }),
    json(),
    typescript({ sourceMap: true, tsconfig: 'tsconfig.json' }),
  ],
};
