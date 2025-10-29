import { GraphQLScalarType, Kind } from 'graphql';

export default class CustomScalarTypes {
  public static Timestamp(): GraphQLScalarType<Date, number> {
    return new GraphQLScalarType<Date, number>({
      name: 'Timestamp',
      description: 'Custom scalar representing a Unix timestamp in milliseconds',

      // Server → Client
      serialize(value) {
        if (value instanceof Date) {
          return value.getTime();
        }

        if (typeof value === 'number') {
          return value;
        }

        throw new Error('GraphQL Timestamp serializer expected a Date or number');
      },

      // Client → Server (variables)
      parseValue(value) {
        if (typeof value === 'number' || typeof value === 'string') {
          const timestamp = Number(value);
          if (Number.isNaN(timestamp)) {
            throw new Error('GraphQL Timestamp parseValue expects a valid number');
          }
          return new Date(timestamp);
        }

        throw new Error('GraphQL Timestamp parseValue expects a number or string');
      },

      // Client → Server (inline literal)
      parseLiteral(ast) {
        if (ast.kind === Kind.INT) {
          return new Date(parseInt(ast.value, 10));
        }
        throw new Error('GraphQL Timestamp literal must be an integer');
      },
    });
  }
}
