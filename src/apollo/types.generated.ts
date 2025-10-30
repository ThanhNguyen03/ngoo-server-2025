import { GraphQLResolveInfo, GraphQLScalarType, GraphQLScalarTypeConfig } from 'graphql';
import { TAppContext } from '@/helper';
export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
export type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]?: Maybe<T[SubKey]> };
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]: Maybe<T[SubKey]> };
export type MakeEmpty<T extends { [key: string]: unknown }, K extends keyof T> = { [_ in K]?: never };
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
export type RequireFields<T, K extends keyof T> = Omit<T, K> & { [P in K]-?: NonNullable<T[P]> };
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string; }
  String: { input: string; output: string; }
  Boolean: { input: boolean; output: boolean; }
  Int: { input: number; output: number; }
  Float: { input: number; output: number; }
  Object: { input: {[key: string]: unknown}; output: {[key: string]: unknown}; }
  Timestamp: { input: number; output: number; }
};

export type Category = {
  __typename?: 'Category';
  categoryId: Scalars['String']['output'];
  name: Scalars['String']['output'];
};

export type CategoryInput = {
  categoryId: Scalars['String']['input'];
  name: Scalars['String']['input'];
};

/** Input types */
export type ConfirmPaymentInput = {
  orderId: Scalars['String']['input'];
  paymentMethod: EPaymentMethod;
  transactionId?: InputMaybe<Scalars['String']['input']>;
  txHash?: InputMaybe<Scalars['String']['input']>;
};

export type CreateAuditLogInput = {
  action: EAuditAction;
  diff?: InputMaybe<Scalars['Object']['input']>;
  metadata?: InputMaybe<Scalars['Object']['input']>;
  targetId: Scalars['String']['input'];
  targetType: ETargetType;
  userId: Scalars['String']['input'];
};

export type CreateItemInput = {
  additionalOption?: InputMaybe<Array<InputMaybe<ItemOptionInput>>>;
  categoryId: Scalars['String']['input'];
  description?: InputMaybe<Scalars['String']['input']>;
  discountPercent?: InputMaybe<Scalars['Float']['input']>;
  image: Scalars['String']['input'];
  name: Scalars['String']['input'];
  price: Scalars['Float']['input'];
  requireOption?: InputMaybe<Array<InputMaybe<ItemOptionInput>>>;
  status?: InputMaybe<EItemStatus>;
};

export type CreateOrderInput = {
  items: Array<OrderItemInput>;
  paymentMethod: EPaymentMethod;
  userId: Scalars['String']['input'];
};

export enum EAuditAction {
  Create = 'CREATE',
  Delete = 'DELETE',
  Login = 'LOGIN',
  Logout = 'LOGOUT',
  Other = 'OTHER',
  Payment = 'PAYMENT',
  Update = 'UPDATE'
}

export enum EItemStatus {
  Empty = 'EMPTY',
  New = 'NEW',
  Seller = 'SELLER'
}

export enum EOrderStatus {
  Cancelled = 'CANCELLED',
  Completed = 'COMPLETED',
  Delivering = 'DELIVERING',
  Pending = 'PENDING'
}

export enum EPaymentMethod {
  Cod = 'COD',
  Crypto = 'CRYPTO',
  Momo = 'MOMO'
}

export enum EPaymentStatus {
  Failed = 'FAILED',
  Pending = 'PENDING',
  Successful = 'SUCCESSFUL'
}

export enum ERole {
  Admin = 'ADMIN',
  User = 'USER'
}

export enum ESort {
  Asc = 'asc',
  Desc = 'desc'
}

export enum ETargetType {
  Category = 'Category',
  Item = 'Item',
  Order = 'Order',
  System = 'System',
  Transaction = 'Transaction',
  User = 'User'
}

export type ItemOptionInput = {
  extraPrice?: InputMaybe<Scalars['Float']['input']>;
  group: Scalars['String']['input'];
  name: Scalars['String']['input'];
};

export type Mutation = {
  __typename?: 'Mutation';
  confirmPayment: TPaymentResponse;
  createAuditLog: TAuditLog;
  createCategory: Category;
  createItem: TItem;
  createOrder: TOrderResponse;
  deleteCategory?: Maybe<Scalars['Boolean']['output']>;
  deleteItem: Scalars['Boolean']['output'];
  refreshToken: TUserAuth;
  updateCategory: Category;
  updateItem: TItem;
  userConnectCryptoWallet: TConnectCryptoWalletResponse;
  userLogin: TUserAuth;
  userLogout: Scalars['Boolean']['output'];
};


export type MutationConfirmPaymentArgs = {
  paymentInput: ConfirmPaymentInput;
};


export type MutationCreateAuditLogArgs = {
  input: CreateAuditLogInput;
};


export type MutationCreateCategoryArgs = {
  name: Scalars['String']['input'];
};


export type MutationCreateItemArgs = {
  input: CreateItemInput;
};


export type MutationCreateOrderArgs = {
  input: CreateOrderInput;
};


export type MutationDeleteCategoryArgs = {
  categoryId: Scalars['String']['input'];
};


export type MutationDeleteItemArgs = {
  itemId: Scalars['String']['input'];
};


export type MutationRefreshTokenArgs = {
  refreshToken: Scalars['String']['input'];
};


export type MutationUpdateCategoryArgs = {
  category: CategoryInput;
};


export type MutationUpdateItemArgs = {
  input: UpdateItemInput;
};


export type MutationUserConnectCryptoWalletArgs = {
  address: Scalars['String']['input'];
  signature: Scalars['String']['input'];
};


export type MutationUserLoginArgs = {
  token: Scalars['String']['input'];
};


export type MutationUserLogoutArgs = {
  logoutEverywhere?: InputMaybe<Scalars['Boolean']['input']>;
};

/** Input types */
export type OrderItemInput = {
  itemId: Scalars['String']['input'];
  note?: InputMaybe<Scalars['String']['input']>;
  quantity: Scalars['Int']['input'];
  selectedOptions?: InputMaybe<Array<InputMaybe<ItemOptionInput>>>;
};

export type PaginationInput = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
  query?: InputMaybe<Array<InputMaybe<QueryByInput>>>;
};

export type Query = {
  __typename?: 'Query';
  cryptoWalletWithNone: Scalars['String']['output'];
  getAuditLog?: Maybe<TAuditLog>;
  getItemByCategory: TItem;
  listAuditLog: Array<TAuditLog>;
  listCategory: Array<Maybe<Category>>;
  listItem: TItemResponse;
  listPaymentHistory: Array<Maybe<TPaymentResponse>>;
  paymentHistory: TPaymentResponse;
  userInfo: UserInfo;
};


export type QueryGetAuditLogArgs = {
  id: Scalars['String']['input'];
};


export type QueryGetItemByCategoryArgs = {
  categoryId: Scalars['String']['input'];
};


export type QueryListAuditLogArgs = {
  action?: InputMaybe<EAuditAction>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
  targetId: Scalars['String']['input'];
  targetType?: InputMaybe<ETargetType>;
  userId: Scalars['String']['input'];
};


export type QueryListItemArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
  query?: InputMaybe<Array<InputMaybe<QueryByInput>>>;
};


export type QueryListPaymentHistoryArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
  query?: InputMaybe<Array<InputMaybe<QueryByInput>>>;
};


export type QueryPaymentHistoryArgs = {
  paymentId: Scalars['String']['input'];
};

export type QueryByInput = {
  column?: InputMaybe<Scalars['String']['input']>;
  sort?: InputMaybe<ESort>;
};

export type TAuditDiff = {
  __typename?: 'TAuditDiff';
  newValue?: Maybe<Scalars['Object']['output']>;
  oldValue?: Maybe<Scalars['Object']['output']>;
};

export type TAuditLog = {
  __typename?: 'TAuditLog';
  action: EAuditAction;
  createdAt: Scalars['Timestamp']['output'];
  diff?: Maybe<TAuditDiff>;
  id: Scalars['String']['output'];
  metadata?: Maybe<Scalars['Object']['output']>;
  targetId: Scalars['String']['output'];
  targetType: ETargetType;
  userId: Scalars['String']['output'];
};

export type TAuditMetadata = {
  __typename?: 'TAuditMetadata';
  key?: Maybe<Scalars['String']['output']>;
  refId?: Maybe<Scalars['String']['output']>;
  value?: Maybe<Scalars['String']['output']>;
};

export type TConnectCryptoWalletResponse = {
  __typename?: 'TConnectCryptoWalletResponse';
  connectCompleted: Scalars['Boolean']['output'];
  userUuid: Scalars['String']['output'];
  walletAddress: Scalars['String']['output'];
};

export type TItem = {
  __typename?: 'TItem';
  additionalOption?: Maybe<Array<Maybe<TItemOption>>>;
  categoryName: Scalars['String']['output'];
  createdAt: Scalars['Timestamp']['output'];
  description?: Maybe<Scalars['String']['output']>;
  discountPercent?: Maybe<Scalars['Float']['output']>;
  image: Scalars['String']['output'];
  itemId: Scalars['String']['output'];
  name: Scalars['String']['output'];
  price: Scalars['Float']['output'];
  requireOption?: Maybe<Array<Maybe<TItemOption>>>;
  status?: Maybe<EItemStatus>;
  updatedAt: Scalars['Timestamp']['output'];
};

export type TItemOption = {
  __typename?: 'TItemOption';
  extraPrice?: Maybe<Scalars['Float']['output']>;
  group: Scalars['String']['output'];
  name: Scalars['String']['output'];
};

export type TItemResponse = {
  __typename?: 'TItemResponse';
  limit: Scalars['Int']['output'];
  offset: Scalars['Int']['output'];
  query: Array<Maybe<TQueryBy>>;
  records: Array<Maybe<TItem>>;
  total: Scalars['Int']['output'];
};

export type TOrderItem = {
  __typename?: 'TOrderItem';
  discountPercent?: Maybe<Scalars['Float']['output']>;
  name: Scalars['String']['output'];
  note?: Maybe<Scalars['String']['output']>;
  price: Scalars['Float']['output'];
  quantity: Scalars['Int']['output'];
  selectedOptions?: Maybe<Array<Maybe<TItemOption>>>;
};

export type TOrderResponse = {
  __typename?: 'TOrderResponse';
  createdAt: Scalars['Timestamp']['output'];
  cryptoPaymentData?: Maybe<Scalars['String']['output']>;
  momoPaymentUrl?: Maybe<Scalars['String']['output']>;
  monoRequestId?: Maybe<Scalars['String']['output']>;
  orderId: Scalars['String']['output'];
  updatedAt: Scalars['Timestamp']['output'];
};

export type TPaymentResponse = {
  __typename?: 'TPaymentResponse';
  createdAt: Scalars['Timestamp']['output'];
  items: Array<Maybe<TOrderItem>>;
  orderID: Scalars['String']['output'];
  paymentId: Scalars['String']['output'];
  paymentMethod: EPaymentMethod;
  status: EPaymentStatus;
  totalPrice: Scalars['Float']['output'];
  updatedAt: Scalars['Timestamp']['output'];
  userInfo: TUserInfoSnapshot;
};

export type TQueryBy = {
  __typename?: 'TQueryBy';
  column?: Maybe<Scalars['String']['output']>;
  sort?: Maybe<ESort>;
};

export type TUserAuth = {
  __typename?: 'TUserAuth';
  accessToken: Scalars['String']['output'];
  refreshToken: Scalars['String']['output'];
  userUuid: Scalars['String']['output'];
};

export type TUserInfoSnapshot = {
  __typename?: 'TUserInfoSnapshot';
  address: Scalars['String']['output'];
  email: Scalars['String']['output'];
  name?: Maybe<Scalars['String']['output']>;
  phoneNumber: Scalars['String']['output'];
};

export type UpdateItemInput = {
  additionalOption?: InputMaybe<Array<InputMaybe<ItemOptionInput>>>;
  categoryId?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  discountPercent?: InputMaybe<Scalars['Float']['input']>;
  image?: InputMaybe<Scalars['String']['input']>;
  itemId: Scalars['String']['input'];
  name?: InputMaybe<Scalars['String']['input']>;
  price?: InputMaybe<Scalars['Float']['input']>;
  requireOption?: InputMaybe<Array<InputMaybe<ItemOptionInput>>>;
  status?: InputMaybe<Array<InputMaybe<EItemStatus>>>;
};

export type UserInfo = {
  __typename?: 'UserInfo';
  address?: Maybe<Scalars['String']['output']>;
  email: Scalars['String']['output'];
  name?: Maybe<Scalars['String']['output']>;
  phoneNumber?: Maybe<Scalars['String']['output']>;
  role: ERole;
  uuid: Scalars['String']['output'];
  walletAddress?: Maybe<Scalars['String']['output']>;
};



export type ResolverTypeWrapper<T> = Promise<T> | T;


export type ResolverWithResolve<TResult, TParent, TContext, TArgs> = {
  resolve: ResolverFn<TResult, TParent, TContext, TArgs>;
};
export type Resolver<TResult, TParent = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>, TArgs = Record<PropertyKey, never>> = ResolverFn<TResult, TParent, TContext, TArgs> | ResolverWithResolve<TResult, TParent, TContext, TArgs>;

export type ResolverFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => Promise<TResult> | TResult;

export type SubscriptionSubscribeFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => AsyncIterable<TResult> | Promise<AsyncIterable<TResult>>;

export type SubscriptionResolveFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => TResult | Promise<TResult>;

export interface SubscriptionSubscriberObject<TResult, TKey extends string, TParent, TContext, TArgs> {
  subscribe: SubscriptionSubscribeFn<{ [key in TKey]: TResult }, TParent, TContext, TArgs>;
  resolve?: SubscriptionResolveFn<TResult, { [key in TKey]: TResult }, TContext, TArgs>;
}

export interface SubscriptionResolverObject<TResult, TParent, TContext, TArgs> {
  subscribe: SubscriptionSubscribeFn<any, TParent, TContext, TArgs>;
  resolve: SubscriptionResolveFn<TResult, any, TContext, TArgs>;
}

export type SubscriptionObject<TResult, TKey extends string, TParent, TContext, TArgs> =
  | SubscriptionSubscriberObject<TResult, TKey, TParent, TContext, TArgs>
  | SubscriptionResolverObject<TResult, TParent, TContext, TArgs>;

export type SubscriptionResolver<TResult, TKey extends string, TParent = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>, TArgs = Record<PropertyKey, never>> =
  | ((...args: any[]) => SubscriptionObject<TResult, TKey, TParent, TContext, TArgs>)
  | SubscriptionObject<TResult, TKey, TParent, TContext, TArgs>;

export type TypeResolveFn<TTypes, TParent = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>> = (
  parent: TParent,
  context: TContext,
  info: GraphQLResolveInfo
) => Maybe<TTypes> | Promise<Maybe<TTypes>>;

export type IsTypeOfResolverFn<T = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>> = (obj: T, context: TContext, info: GraphQLResolveInfo) => boolean | Promise<boolean>;

export type NextResolverFn<T> = () => Promise<T>;

export type DirectiveResolverFn<TResult = Record<PropertyKey, never>, TParent = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>, TArgs = Record<PropertyKey, never>> = (
  next: NextResolverFn<TResult>,
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => TResult | Promise<TResult>;





/** Mapping between all available schema types and the resolvers types */
export type ResolversTypes = {
  Boolean: ResolverTypeWrapper<Scalars['Boolean']['output']>;
  Category: ResolverTypeWrapper<Category>;
  CategoryInput: CategoryInput;
  ConfirmPaymentInput: ConfirmPaymentInput;
  CreateAuditLogInput: CreateAuditLogInput;
  CreateItemInput: CreateItemInput;
  CreateOrderInput: CreateOrderInput;
  EAuditAction: EAuditAction;
  EItemStatus: EItemStatus;
  EOrderStatus: EOrderStatus;
  EPaymentMethod: EPaymentMethod;
  EPaymentStatus: EPaymentStatus;
  ERole: ERole;
  ESort: ESort;
  ETargetType: ETargetType;
  Float: ResolverTypeWrapper<Scalars['Float']['output']>;
  Int: ResolverTypeWrapper<Scalars['Int']['output']>;
  ItemOptionInput: ItemOptionInput;
  Mutation: ResolverTypeWrapper<Record<PropertyKey, never>>;
  Object: ResolverTypeWrapper<Scalars['Object']['output']>;
  OrderItemInput: OrderItemInput;
  PaginationInput: PaginationInput;
  Query: ResolverTypeWrapper<Record<PropertyKey, never>>;
  QueryByInput: QueryByInput;
  String: ResolverTypeWrapper<Scalars['String']['output']>;
  TAuditDiff: ResolverTypeWrapper<TAuditDiff>;
  TAuditLog: ResolverTypeWrapper<TAuditLog>;
  TAuditMetadata: ResolverTypeWrapper<TAuditMetadata>;
  TConnectCryptoWalletResponse: ResolverTypeWrapper<TConnectCryptoWalletResponse>;
  TItem: ResolverTypeWrapper<TItem>;
  TItemOption: ResolverTypeWrapper<TItemOption>;
  TItemResponse: ResolverTypeWrapper<TItemResponse>;
  TOrderItem: ResolverTypeWrapper<TOrderItem>;
  TOrderResponse: ResolverTypeWrapper<TOrderResponse>;
  TPaymentResponse: ResolverTypeWrapper<TPaymentResponse>;
  TQueryBy: ResolverTypeWrapper<TQueryBy>;
  TUserAuth: ResolverTypeWrapper<TUserAuth>;
  TUserInfoSnapshot: ResolverTypeWrapper<TUserInfoSnapshot>;
  Timestamp: ResolverTypeWrapper<Scalars['Timestamp']['output']>;
  UpdateItemInput: UpdateItemInput;
  UserInfo: ResolverTypeWrapper<UserInfo>;
};

/** Mapping between all available schema types and the resolvers parents */
export type ResolversParentTypes = {
  Boolean: Scalars['Boolean']['output'];
  Category: Category;
  CategoryInput: CategoryInput;
  ConfirmPaymentInput: ConfirmPaymentInput;
  CreateAuditLogInput: CreateAuditLogInput;
  CreateItemInput: CreateItemInput;
  CreateOrderInput: CreateOrderInput;
  Float: Scalars['Float']['output'];
  Int: Scalars['Int']['output'];
  ItemOptionInput: ItemOptionInput;
  Mutation: Record<PropertyKey, never>;
  Object: Scalars['Object']['output'];
  OrderItemInput: OrderItemInput;
  PaginationInput: PaginationInput;
  Query: Record<PropertyKey, never>;
  QueryByInput: QueryByInput;
  String: Scalars['String']['output'];
  TAuditDiff: TAuditDiff;
  TAuditLog: TAuditLog;
  TAuditMetadata: TAuditMetadata;
  TConnectCryptoWalletResponse: TConnectCryptoWalletResponse;
  TItem: TItem;
  TItemOption: TItemOption;
  TItemResponse: TItemResponse;
  TOrderItem: TOrderItem;
  TOrderResponse: TOrderResponse;
  TPaymentResponse: TPaymentResponse;
  TQueryBy: TQueryBy;
  TUserAuth: TUserAuth;
  TUserInfoSnapshot: TUserInfoSnapshot;
  Timestamp: Scalars['Timestamp']['output'];
  UpdateItemInput: UpdateItemInput;
  UserInfo: UserInfo;
};

export type CategoryResolvers<ContextType = TAppContext, ParentType extends ResolversParentTypes['Category'] = ResolversParentTypes['Category']> = {
  categoryId?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
};

export type MutationResolvers<ContextType = TAppContext, ParentType extends ResolversParentTypes['Mutation'] = ResolversParentTypes['Mutation']> = {
  confirmPayment?: Resolver<ResolversTypes['TPaymentResponse'], ParentType, ContextType, RequireFields<MutationConfirmPaymentArgs, 'paymentInput'>>;
  createAuditLog?: Resolver<ResolversTypes['TAuditLog'], ParentType, ContextType, RequireFields<MutationCreateAuditLogArgs, 'input'>>;
  createCategory?: Resolver<ResolversTypes['Category'], ParentType, ContextType, RequireFields<MutationCreateCategoryArgs, 'name'>>;
  createItem?: Resolver<ResolversTypes['TItem'], ParentType, ContextType, RequireFields<MutationCreateItemArgs, 'input'>>;
  createOrder?: Resolver<ResolversTypes['TOrderResponse'], ParentType, ContextType, RequireFields<MutationCreateOrderArgs, 'input'>>;
  deleteCategory?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType, RequireFields<MutationDeleteCategoryArgs, 'categoryId'>>;
  deleteItem?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType, RequireFields<MutationDeleteItemArgs, 'itemId'>>;
  refreshToken?: Resolver<ResolversTypes['TUserAuth'], ParentType, ContextType, RequireFields<MutationRefreshTokenArgs, 'refreshToken'>>;
  updateCategory?: Resolver<ResolversTypes['Category'], ParentType, ContextType, RequireFields<MutationUpdateCategoryArgs, 'category'>>;
  updateItem?: Resolver<ResolversTypes['TItem'], ParentType, ContextType, RequireFields<MutationUpdateItemArgs, 'input'>>;
  userConnectCryptoWallet?: Resolver<ResolversTypes['TConnectCryptoWalletResponse'], ParentType, ContextType, RequireFields<MutationUserConnectCryptoWalletArgs, 'address' | 'signature'>>;
  userLogin?: Resolver<ResolversTypes['TUserAuth'], ParentType, ContextType, RequireFields<MutationUserLoginArgs, 'token'>>;
  userLogout?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType, Partial<MutationUserLogoutArgs>>;
};

export interface ObjectScalarConfig extends GraphQLScalarTypeConfig<ResolversTypes['Object'], any> {
  name: 'Object';
}

export type QueryResolvers<ContextType = TAppContext, ParentType extends ResolversParentTypes['Query'] = ResolversParentTypes['Query']> = {
  cryptoWalletWithNone?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  getAuditLog?: Resolver<Maybe<ResolversTypes['TAuditLog']>, ParentType, ContextType, RequireFields<QueryGetAuditLogArgs, 'id'>>;
  getItemByCategory?: Resolver<ResolversTypes['TItem'], ParentType, ContextType, RequireFields<QueryGetItemByCategoryArgs, 'categoryId'>>;
  listAuditLog?: Resolver<Array<ResolversTypes['TAuditLog']>, ParentType, ContextType, RequireFields<QueryListAuditLogArgs, 'targetId' | 'userId'>>;
  listCategory?: Resolver<Array<Maybe<ResolversTypes['Category']>>, ParentType, ContextType>;
  listItem?: Resolver<ResolversTypes['TItemResponse'], ParentType, ContextType, Partial<QueryListItemArgs>>;
  listPaymentHistory?: Resolver<Array<Maybe<ResolversTypes['TPaymentResponse']>>, ParentType, ContextType, Partial<QueryListPaymentHistoryArgs>>;
  paymentHistory?: Resolver<ResolversTypes['TPaymentResponse'], ParentType, ContextType, RequireFields<QueryPaymentHistoryArgs, 'paymentId'>>;
  userInfo?: Resolver<ResolversTypes['UserInfo'], ParentType, ContextType>;
};

export type TAuditDiffResolvers<ContextType = TAppContext, ParentType extends ResolversParentTypes['TAuditDiff'] = ResolversParentTypes['TAuditDiff']> = {
  newValue?: Resolver<Maybe<ResolversTypes['Object']>, ParentType, ContextType>;
  oldValue?: Resolver<Maybe<ResolversTypes['Object']>, ParentType, ContextType>;
};

export type TAuditLogResolvers<ContextType = TAppContext, ParentType extends ResolversParentTypes['TAuditLog'] = ResolversParentTypes['TAuditLog']> = {
  action?: Resolver<ResolversTypes['EAuditAction'], ParentType, ContextType>;
  createdAt?: Resolver<ResolversTypes['Timestamp'], ParentType, ContextType>;
  diff?: Resolver<Maybe<ResolversTypes['TAuditDiff']>, ParentType, ContextType>;
  id?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  metadata?: Resolver<Maybe<ResolversTypes['Object']>, ParentType, ContextType>;
  targetId?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  targetType?: Resolver<ResolversTypes['ETargetType'], ParentType, ContextType>;
  userId?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
};

export type TAuditMetadataResolvers<ContextType = TAppContext, ParentType extends ResolversParentTypes['TAuditMetadata'] = ResolversParentTypes['TAuditMetadata']> = {
  key?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  refId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  value?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
};

export type TConnectCryptoWalletResponseResolvers<ContextType = TAppContext, ParentType extends ResolversParentTypes['TConnectCryptoWalletResponse'] = ResolversParentTypes['TConnectCryptoWalletResponse']> = {
  connectCompleted?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  userUuid?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  walletAddress?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
};

export type TItemResolvers<ContextType = TAppContext, ParentType extends ResolversParentTypes['TItem'] = ResolversParentTypes['TItem']> = {
  additionalOption?: Resolver<Maybe<Array<Maybe<ResolversTypes['TItemOption']>>>, ParentType, ContextType>;
  categoryName?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  createdAt?: Resolver<ResolversTypes['Timestamp'], ParentType, ContextType>;
  description?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  discountPercent?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  image?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  itemId?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  price?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  requireOption?: Resolver<Maybe<Array<Maybe<ResolversTypes['TItemOption']>>>, ParentType, ContextType>;
  status?: Resolver<Maybe<ResolversTypes['EItemStatus']>, ParentType, ContextType>;
  updatedAt?: Resolver<ResolversTypes['Timestamp'], ParentType, ContextType>;
};

export type TItemOptionResolvers<ContextType = TAppContext, ParentType extends ResolversParentTypes['TItemOption'] = ResolversParentTypes['TItemOption']> = {
  extraPrice?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  group?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
};

export type TItemResponseResolvers<ContextType = TAppContext, ParentType extends ResolversParentTypes['TItemResponse'] = ResolversParentTypes['TItemResponse']> = {
  limit?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  offset?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  query?: Resolver<Array<Maybe<ResolversTypes['TQueryBy']>>, ParentType, ContextType>;
  records?: Resolver<Array<Maybe<ResolversTypes['TItem']>>, ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
};

export type TOrderItemResolvers<ContextType = TAppContext, ParentType extends ResolversParentTypes['TOrderItem'] = ResolversParentTypes['TOrderItem']> = {
  discountPercent?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  note?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  price?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  quantity?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  selectedOptions?: Resolver<Maybe<Array<Maybe<ResolversTypes['TItemOption']>>>, ParentType, ContextType>;
};

export type TOrderResponseResolvers<ContextType = TAppContext, ParentType extends ResolversParentTypes['TOrderResponse'] = ResolversParentTypes['TOrderResponse']> = {
  createdAt?: Resolver<ResolversTypes['Timestamp'], ParentType, ContextType>;
  cryptoPaymentData?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  momoPaymentUrl?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  monoRequestId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  orderId?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  updatedAt?: Resolver<ResolversTypes['Timestamp'], ParentType, ContextType>;
};

export type TPaymentResponseResolvers<ContextType = TAppContext, ParentType extends ResolversParentTypes['TPaymentResponse'] = ResolversParentTypes['TPaymentResponse']> = {
  createdAt?: Resolver<ResolversTypes['Timestamp'], ParentType, ContextType>;
  items?: Resolver<Array<Maybe<ResolversTypes['TOrderItem']>>, ParentType, ContextType>;
  orderID?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  paymentId?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  paymentMethod?: Resolver<ResolversTypes['EPaymentMethod'], ParentType, ContextType>;
  status?: Resolver<ResolversTypes['EPaymentStatus'], ParentType, ContextType>;
  totalPrice?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  updatedAt?: Resolver<ResolversTypes['Timestamp'], ParentType, ContextType>;
  userInfo?: Resolver<ResolversTypes['TUserInfoSnapshot'], ParentType, ContextType>;
};

export type TQueryByResolvers<ContextType = TAppContext, ParentType extends ResolversParentTypes['TQueryBy'] = ResolversParentTypes['TQueryBy']> = {
  column?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  sort?: Resolver<Maybe<ResolversTypes['ESort']>, ParentType, ContextType>;
};

export type TUserAuthResolvers<ContextType = TAppContext, ParentType extends ResolversParentTypes['TUserAuth'] = ResolversParentTypes['TUserAuth']> = {
  accessToken?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  refreshToken?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  userUuid?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
};

export type TUserInfoSnapshotResolvers<ContextType = TAppContext, ParentType extends ResolversParentTypes['TUserInfoSnapshot'] = ResolversParentTypes['TUserInfoSnapshot']> = {
  address?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  email?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  name?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  phoneNumber?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
};

export interface TimestampScalarConfig extends GraphQLScalarTypeConfig<ResolversTypes['Timestamp'], any> {
  name: 'Timestamp';
}

export type UserInfoResolvers<ContextType = TAppContext, ParentType extends ResolversParentTypes['UserInfo'] = ResolversParentTypes['UserInfo']> = {
  address?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  email?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  name?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  phoneNumber?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  role?: Resolver<ResolversTypes['ERole'], ParentType, ContextType>;
  uuid?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  walletAddress?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
};

export type Resolvers<ContextType = TAppContext> = {
  Category?: CategoryResolvers<ContextType>;
  Mutation?: MutationResolvers<ContextType>;
  Object?: GraphQLScalarType;
  Query?: QueryResolvers<ContextType>;
  TAuditDiff?: TAuditDiffResolvers<ContextType>;
  TAuditLog?: TAuditLogResolvers<ContextType>;
  TAuditMetadata?: TAuditMetadataResolvers<ContextType>;
  TConnectCryptoWalletResponse?: TConnectCryptoWalletResponseResolvers<ContextType>;
  TItem?: TItemResolvers<ContextType>;
  TItemOption?: TItemOptionResolvers<ContextType>;
  TItemResponse?: TItemResponseResolvers<ContextType>;
  TOrderItem?: TOrderItemResolvers<ContextType>;
  TOrderResponse?: TOrderResponseResolvers<ContextType>;
  TPaymentResponse?: TPaymentResponseResolvers<ContextType>;
  TQueryBy?: TQueryByResolvers<ContextType>;
  TUserAuth?: TUserAuthResolvers<ContextType>;
  TUserInfoSnapshot?: TUserInfoSnapshotResolvers<ContextType>;
  Timestamp?: GraphQLScalarType;
  UserInfo?: UserInfoResolvers<ContextType>;
};

