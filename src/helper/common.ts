export enum EUserAuthenticationStatus {
  Guest,
  Unauthenticated,
  Authenticated,
}

export type TAppContext = {
  /** Default user is a guest who can access public endpoints, then depends on
   * the requirement, middleware and resolver, it can be changed to
   * unauthenticated (e.g. due to invalid token) or authenticated user. */
  user:
    | {
        readonly kind: EUserAuthenticationStatus.Guest;
        readonly token?: string;
      }
    | {
        readonly kind: EUserAuthenticationStatus.Unauthenticated;
        readonly token?: string;
        readonly reason: Error;
      }
    | {
        readonly kind: EUserAuthenticationStatus.Authenticated;
        readonly token: string;
        userId: string;
        userUuid: string;
      };
};
