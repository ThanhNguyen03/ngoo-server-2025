import { config, JwtAuthAccessTokenInstance, RedisHelper } from '@helper';
import { EPaymentStatus } from '@generated/graphql';
import { createLogger } from '@lib';
import http from 'http';
import { Server } from 'socket.io';

const logger = createLogger('Socket');

export let io: Server;

/**
 * Emit a payment status update to the user's Socket.IO room.
 *
 * Centralises all `paymentStatus` emissions so callers don't need to
 * reference the `io` singleton directly or repeat the event name/payload
 * shape. The user is automatically joined to a room keyed by their userId
 * on socket connection (see `initSocket`).
 *
 * @param userId    The UUID of the user who owns the order.
 * @param payload   The status update data to send.
 */
export const emitPaymentStatus = (
  userId: string,
  payload: { orderId: string; paymentId: string; status: EPaymentStatus },
): void => {
  io.to(userId).emit('paymentStatus', payload);
};

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
      logger.error({ err }, 'Socket authentication error');
      next(new Error('Unauthorized'));
    }
  });

  // CONNECTION
  io.on('connection', (socket) => {
    const userId = socket.data.user.userId;

    // join room = userId (trusted)
    socket.join(userId);
    logger.debug({ socketId: socket.id }, 'Socket connected');
    socket.on('disconnect', (reason) => {
      logger.debug({ socketId: socket.id, reason }, 'Socket disconnected');
    });
  });
};
