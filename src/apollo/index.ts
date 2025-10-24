import { readFileSync } from '@/helper';
import { resolverUser } from './app/user';
import { resolverCategory } from './app/category';

const typeDefAuditLog = readFileSync('./src/apollo/app/audit-log/audit.graphql');
const typeDefCategory = readFileSync('./src/apollo/app/category/category.graphql');
const typeDefItem = readFileSync('./src/apollo/app/item/item.graphql');
const typeDefOrder = readFileSync('./src/apollo/app/order/order.graphql');
const typeDefPayment = readFileSync('./src/apollo/app/payment/payment.graphql');
const typeDefUser = readFileSync('./src/apollo/app/user/user.graphql');

export const TypedefApp = [typeDefAuditLog, typeDefCategory, typeDefItem, typeDefOrder, typeDefPayment, typeDefUser];

export const ResolverApp = [resolverUser, resolverCategory];
