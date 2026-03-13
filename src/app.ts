import { ApolloServer, BaseContext } from '@apollo/server';
import cors from 'cors';
import express, { Application } from 'express';
import { GraphQLFormattedError } from 'graphql';
import helmet from 'helmet';
import http from 'http';
import { ResolverApp, TypedefApp } from './apollo';

import { expressMiddleware } from '@apollo/server/express4';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import {
  ApolloServerPluginLandingPageLocalDefault,
  ApolloServerPluginLandingPageProductionDefault,
} from '@apollo/server/plugin/landingPage/default';
import { config, EUserAuthenticationStatus, JwtAuthAccessTokenInstance, TAppContext } from '@helper';
import { createLogger } from '@lib';
import { initSocket, RedisInstance } from '@service';
import { RedisStore } from 'connect-redis';
import { randomUUID } from 'crypto';
import session from 'express-session';
import router from './services/webhook';

const logger = createLogger('App');

const HSTS_HELMET_MAX_AGE_IN_SECONDS = 30 * 24 * 3600; // 30 days

export const NGOO_API = {
  clusterName: 'ngoo-server-api',
  payload: async (): Promise<http.Server> => {
    const app = express();

    // --- PayPal Webhook ---
    app.use('/webhook/paypal', express.raw({ type: 'application/json', limit: config.REQUEST_BODY_LIMIT }), router);
    // --- Middleware ---
    app.use(express.json({ limit: config.REQUEST_BODY_LIMIT }));
    // protect
    app.use(
      helmet({
        // Enable CSP to prevent XSS and other attacks.
        // Disable CSP in 'local' to ensure Apollo Server renders
        contentSecurityPolicy: config.NODE_ENV !== 'local',
        // set the “X-Frame-Options” header to prevent clickjacking attacks
        frameguard: { action: 'deny' },
        // set the “X-XSS-Protection” header to prevent cross-site scripting (XSS) attacks
        xXssProtection: true,
        hsts: {
          // 30 days
          maxAge: HSTS_HELMET_MAX_AGE_IN_SECONDS,
          // removing the "includeSubDomains" option
          includeSubDomains: false,
        },
        // Enable X-Content-Type-Options: nosniff to prevent MIME-type sniffing.
        // Browsers that sniff MIME types can execute uploaded files as scripts.
        noSniff: true,
      }),
    );

    // config CORS to allow credentials like cookies to be sent from client to server
    app.use(
      cors({
        origin: [config.FE_ALLOWED_URL],
        credentials: true,
      }),
    );
    const httpServer = http.createServer(app);

    // --- Redis Session ---
    await RedisInstance.connect();

    const redisStore: RedisStore = new RedisStore({
      client: RedisInstance.redis,
      prefix: `${config.REDIS_KEY_PREFIX}-express-session-`,
      disableTouch: true, // Disables resetting the TTL when every time a user interacts with the server
    });

    // --- Apollo Server ---
    const server = new ApolloServer<BaseContext>({
      typeDefs: TypedefApp,
      resolvers: ResolverApp,
      formatError: (formattedError: GraphQLFormattedError, error: unknown): GraphQLFormattedError => {
        logger.error({ err: error, formattedError }, 'GraphQL error');
        return formattedError;
      },
      introspection: config.NODE_ENV === 'local',
      // SEC-015: Disable batched HTTP requests to prevent DoS via bulk query attacks.
      // A single HTTP request with hundreds of batched operations could bypass per-request
      // rate limiting and exhaust server resources.
      allowBatchedHttpRequests: false,
      plugins: [
        ApolloServerPluginDrainHttpServer({ httpServer }),
        config.NODE_ENV !== 'local'
          ? ApolloServerPluginLandingPageProductionDefault()
          : ApolloServerPluginLandingPageLocalDefault(),
      ],
      includeStacktraceInErrorResponses: config.NODE_ENV === 'local',
    });

    app.use(
      session({
        genid: () => randomUUID(),
        store: redisStore,
        rolling: false, // force session not to reset expire time base on last call
        resave: false, // required: force lightweight session keep alive (touch)
        saveUninitialized: false, // recommended: only save session when data exists
        secret: config.EXPRESS_SESSION_SECRET,
        cookie: {
          httpOnly: true,
          // SEC-017: Secure flag enforced in all non-local environments so that
          // test/staging deployments also require HTTPS. 'local' is excluded because
          // localhost does not use HTTPS during development.
          // sameSite 'lax': allows cookie on top-level navigations (OAuth redirect)
          // but blocks it on cross-origin sub-resource requests (CSRF mitigation).
          secure: config.NODE_ENV !== 'local',
          sameSite: 'lax',
          path: '/',
          maxAge: config.SESSION_COOKIE_MAX_AGE_SEC * 1000, // milliseconds
        },
      }),
    );

    await server.start();

    app.use(
      '/graphql',
      expressMiddleware(server, {
        context: async ({ req }): Promise<TAppContext> => {
          const ip =
            (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? 'unknown';
          const authHeader = req.headers.authorization;
          if (!authHeader) {
            return { ip, user: { kind: EUserAuthenticationStatus.Guest } };
          }

          const token = authHeader.split(' ')[1];
          try {
            // Verify token — secret (JWT NextAuth)
            const decoded = await JwtAuthAccessTokenInstance.verify(token);

            if (!decoded.payload.uuid) {
              return { user: { kind: EUserAuthenticationStatus.Guest } };
            }

            return {
              ip,
              user: {
                kind: EUserAuthenticationStatus.Authenticated,
                token,
                userId: decoded.payload.uuid,
                sid: decoded.payload.sid,
                role: decoded.payload.role,
              },
            };
          } catch (err) {
            logger.warn({ err }, 'JWT verification failed');
            return { ip, user: { kind: EUserAuthenticationStatus.Guest } };
          }
        },
      }) as Application,
    );

    // --- Init Socket ---
    initSocket(httpServer);

    await new Promise<void>((resolve) => {
      httpServer.listen({ port: config.PORT }, config.HOST, resolve);
    });

    logger.info(`Server ready at ${config.APP_URL}:${config.PORT}/graphql`);
    return httpServer;
  },
};

export default NGOO_API;
