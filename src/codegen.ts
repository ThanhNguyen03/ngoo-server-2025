import type { CodegenConfig } from '@graphql-codegen/cli';

// Define GraphQL Codegen configuration
const config: CodegenConfig = {
  schema: [
    'src/**/*.graphql', // Local GraphQL schema files
    // { [url]: { headers: { 'x-ngoo-id': clientId } } }, // Remote GraphQL schema with authentication headers
  ],
  generates: {
    './src/apollo/types.generated.ts': {
      plugins: ['typescript', 'typescript-resolvers'],
      config: {
        contextType: '@/helper#TAppContext',
        scalars: {
          BigInt: {
            input: 'bigint',
            output: 'bigint',
          },
        },
      },
    },
  },
};

export default config;
