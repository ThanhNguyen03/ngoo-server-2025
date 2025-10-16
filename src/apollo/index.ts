import { readFileSync } from '@/helper';
import { resolverUser } from './app/user';
import { resolverCategory } from './app/category';

const typeDefUser = readFileSync('./src/apollo/app/user/user.graphql');
const typeCategory = readFileSync('./src/apollo/app/category/category.graphql');

export const TypedefApp = [typeDefUser, typeCategory];

export const ResolverApp = [resolverUser, resolverCategory];
