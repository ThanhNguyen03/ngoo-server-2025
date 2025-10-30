import { readFileSync } from '@/helper';
import { resolverUser } from './app/user';
import { resolverCategory } from './app/category';
import CustomScalarTypes from './scalar';
import { Resolvers } from './types.generated';
import { resolverItem } from './app/item';
import { resolverOrder } from './app/order';

const typeDefUser = readFileSync('./src/apollo/app/user/user.graphql');
const typeDefAuditLog = readFileSync('./src/apollo/app/audit-log/audit.graphql');
const typeDefCategory = readFileSync('./src/apollo/app/category/category.graphql');
const typeDefItem = readFileSync('./src/apollo/app/item/item.graphql');
const typeDefOrder = readFileSync('./src/apollo/app/order/order.graphql');
const typeDefPayment = readFileSync('./src/apollo/app/payment/payment.graphql');
const typeDefCommon = readFileSync('./src/apollo/common.graphql');

const resolverScalars: Resolvers = {
  Timestamp: CustomScalarTypes.Timestamp(),
};

export const TypedefApp = [
  typeDefAuditLog,
  typeDefCategory,
  typeDefItem,
  typeDefOrder,
  typeDefPayment,
  typeDefUser,
  typeDefCommon,
];

export const ResolverApp = [resolverCategory, resolverItem, resolverOrder, resolverUser, resolverScalars];
