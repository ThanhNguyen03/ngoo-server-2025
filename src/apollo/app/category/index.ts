import { Resolvers } from '@/generated/graphql';

export const resolverCategory: Resolvers = {
  Query: {
    categoryDetail: () => {
      return { name: 'Coffee' };
    },

    listCategory: () => {
      return [{ name: 'Coffee' }, { name: 'Milk' }];
    },
  },
};
