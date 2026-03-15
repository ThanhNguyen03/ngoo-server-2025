import { readFileSync } from '@helper';
import { resolverAuditLog } from './app/audit-log';
import { resolverCategory } from './app/category';
import { resolverItem } from './app/item';
import { resolverOrder } from './app/order';
import { resolverPayment } from './app/payment';
import { resolverRecommendation } from './app/recommendation';
import { resolverUser } from './app/user';
import CustomScalarTypes from './scalar';
import { Resolvers } from './types.generated';

const typeDefUser = readFileSync('./src/apollo/app/user/user.graphql');
const typeDefAuditLog = readFileSync('./src/apollo/app/audit-log/audit.graphql');
const typeDefCategory = readFileSync('./src/apollo/app/category/category.graphql');
const typeDefItem = readFileSync('./src/apollo/app/item/item.graphql');
const typeDefOrder = readFileSync('./src/apollo/app/order/order.graphql');
const typeDefPayment = readFileSync('./src/apollo/app/payment/payment.graphql');
const typeDefRecommendation = readFileSync('./src/apollo/app/recommendation/recommendation.graphql');
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
  typeDefRecommendation,
  typeDefUser,
  typeDefCommon,
];

export const ResolverApp = [
  resolverAuditLog,
  resolverCategory,
  resolverItem,
  resolverOrder,
  resolverPayment,
  resolverRecommendation,
  resolverUser,
  resolverScalars,
];
