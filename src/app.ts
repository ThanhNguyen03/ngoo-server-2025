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
import { initSocket, RedisInstance } from '@service';
import { RedisStore } from 'connect-redis';
import { randomUUID } from 'crypto';
import session from 'express-session';
import router from './services/webhook';

const HSTS_HELMET_MAX_AGE_IN_SECONDS = 30 * 24 * 3600; // 30 days
const COOKIE_SESSION_MAX_AGE_IN_SECONDS = 24 * 3600; // 1 day

export const NGOO_API = {
  clusterName: 'ngoo-server-api',
  payload: async () => {
    const app = express();

    // --- PayPal Webhook ---
    app.use('/webhook/paypal', express.raw({ type: 'application/json' }), router);
    // --- Middleware ---
    app.use(express.json());
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
        // not loading the noSniff() middleware
        noSniff: false,
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
        console.error('Root cause:', error, 'formatted:', formattedError);
        return formattedError;
      },
      introspection: config.NODE_ENV === 'local',
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
          path: '/',
          maxAge: COOKIE_SESSION_MAX_AGE_IN_SECONDS * 1000, // milliseconds
        },
      }),
    );

    await server.start();

    app.use(
      '/graphql',
      expressMiddleware(server, {
        context: async ({ req }): Promise<TAppContext> => {
          const authHeader = req.headers.authorization;
          if (!authHeader) {
            return { user: { kind: EUserAuthenticationStatus.Guest } };
          }

          const token = authHeader.split(' ')[1];
          try {
            // Verify token — secret (JWT NextAuth)
            const decoded = await JwtAuthAccessTokenInstance.verify(token);

            if (!decoded.payload.uuid) {
              return { user: { kind: EUserAuthenticationStatus.Guest } };
            }

            return {
              user: {
                kind: EUserAuthenticationStatus.Authenticated,
                token,
                userId: decoded.payload.uuid,
                sid: decoded.payload.sid,
                role: decoded.payload.role,
              },
            };
          } catch (err) {
            console.error('JWT verify failed:', err);
            return { user: { kind: EUserAuthenticationStatus.Guest } };
          }
        },
      }) as Application,
    );

    // --- Init Socket ---
    initSocket(httpServer);

    await new Promise<void>((resolve) => {
      httpServer.listen({ port: config.PORT }, config.HOST, resolve);
    });

    console.debug(`Server ready at ${config.APP_URL}:${config.PORT}/graphql`);
  },
};

export default NGOO_API;
