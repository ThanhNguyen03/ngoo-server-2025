import { config, JwtAuthAccessTokenInstance, RedisHelper } from '@helper';
import http from 'http';
import { Server } from 'socket.io';

export let io: Server;

export const initSocket = (httpServer: http.Server) => {
  io = new Server(httpServer, {
    cors: {
      origin: [config.FE_ALLOWED_URL],
      credentials: true,
    },
  });

  // SOCKET AUTH MIDDLEWARE
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) {
        return next(new Error('Unauthorized'));
      }

      const decoded = await JwtAuthAccessTokenInstance.verify(token);

      if (!decoded.payload?.uuid || !decoded.payload?.sid) {
        return next(new Error('Invalid token'));
      }

      const isRevoked = await RedisHelper.account.isUserAccessTokenRevoked(
        decoded.payload.uuid,
        decoded.payload.sid,
      );
      if (isRevoked) {
        return next(new Error('Unauthorized'));
      }

      // attach user info to socket
      socket.data.user = {
        userId: decoded.payload.uuid,
        role: decoded.payload.role,
        sid: decoded.payload.sid,
      };

      next();
    } catch (err) {
      console.error('[Socket Auth Error]', err);
      next(new Error('Unauthorized'));
    }
  });

  // CONNECTION
  io.on('connection', (socket) => {
    const userId = socket.data.user.userId;

    // join room = userId (trusted)
    socket.join(userId);
    console.log(`[socket] connected`, socket.id);
    socket.on('disconnect', (reason) => {
      console.log(`[socket] user in ${socket.id} disconnected: `, reason);
    });
  });
};
