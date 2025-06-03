import debug from 'debug';
import dotenv from 'dotenv';
import express from 'express';
import http from 'http';
import { Server as SocketIO } from 'socket.io';
import { metrics } from './prometheus';

type UserToFollow = {
  socketId: string;
  username: string;
};
type OnUserFollowedPayload = {
  userToFollow: UserToFollow;
  action: 'FOLLOW' | 'UNFOLLOW';
};

const serverDebug = debug('server');
const ioDebug = debug('io');
const socketDebug = debug('socket');

dotenv.config(
  process.env.NODE_ENV === 'development'
      ? { path: '.env.development' }
      : { path: '.env.production' }
);

const app = express();
const port = process.env.PORT || (process.env.NODE_ENV !== 'development' ? 80 : 3002); // default port to listen
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.send('Excalidraw backend is up :)');
});

const server = http.createServer(app);

server.listen(port, () => {
    serverDebug(`listening on port: ${port}`);
});

const io = new SocketIO(server, {
    transports: ['websocket'],
    cors: {
      allowedHeaders: ['Content-Type', 'Authorization'],
      origin: process.env.CORS_ORIGIN || '*',
      credentials: true,
    },
    allowEIO3: true,
    maxHttpBufferSize: 20e6,
    pingTimeout: 60000
});

// listens on host:9090/metrics
metrics(io, {
    collectDefaultMetrics: true
});

  io.on('connection', (socket) => {
    serverDebug(`connection established! ${socket.conn.request.url}`);
    ioDebug('connection established!');
    io.to(`${socket.id}`).emit('init-room');
    socket.on('join-room', async (roomID) => {
      serverDebug(`${socket.id} has joined ${roomID} for url ${socket.conn.request.url}`);
      await socket.join(roomID);
      const sockets = await io.in(roomID).fetchSockets();
      if (sockets.length <= 1) {
        io.to(`${socket.id}`).emit('first-in-room');
      } else {
        socketDebug(`${socket.id} new-user emitted to room ${roomID}`);
        socket.broadcast.to(roomID).emit('new-user', socket.id);
      }

      io.in(roomID).emit(
        'room-user-change',
        sockets.map((socket) => socket.id),
      );
    });

    socket.on(
      'server-broadcast',
      (roomID: string, encryptedData: ArrayBuffer, iv: Uint8Array) => {
        socketDebug(`${socket.id} sends update to ${roomID}`);
        socket.broadcast.to(roomID).emit('client-broadcast', encryptedData, iv);
      },
    );

    socket.on(
      'server-volatile-broadcast',
      (roomID: string, encryptedData: ArrayBuffer, iv: Uint8Array) => {
        socketDebug(`${socket.id} sends volatile update to ${roomID}`);
        socket.volatile.broadcast
          .to(roomID)
          .emit('client-broadcast', encryptedData, iv);
      },
    );
    
    socket.on('disconnecting', async () => {
      socketDebug(`${socket.id} has disconnected`);
      for (const roomID of Array.from(socket.rooms)) {
        const otherClients = (await io.in(roomID).fetchSockets()).filter(
          (_socket) => _socket.id !== socket.id,
        );

        const isFollowRoom = roomID.startsWith('follow@');

        if (!isFollowRoom && otherClients.length > 0) {
          socket.broadcast.to(roomID).emit(
            'room-user-change',
            otherClients.map((socket) => socket.id),
          );
        }

        if (isFollowRoom && otherClients.length === 0) {
          const socketId = roomID.replace('follow@', '');
          io.to(socketId).emit('broadcast-unfollow');
        }
      }
    });

    socket.on('user-follow', async (payload: OnUserFollowedPayload) => {
      const roomID = `follow@${payload.userToFollow.socketId}`;

      switch (payload.action) {
        case 'FOLLOW': {
          await socket.join(roomID);

          const sockets = await io.in(roomID).fetchSockets();
          const followedBy = sockets.map((socket) => socket.id);

          io.to(payload.userToFollow.socketId).emit(
            'user-follow-room-change',
            followedBy,
          );

          break;
        }
        case 'UNFOLLOW': {
          await socket.leave(roomID);

          const sockets = await io.in(roomID).fetchSockets();
          const followedBy = sockets.map((socket) => socket.id);

          io.to(payload.userToFollow.socketId).emit(
            'user-follow-room-change',
            followedBy,
          );

          break;
        }
      }
    });

    socket.on('disconnect', (reason, details) => {
        serverDebug(
            `${socket.id} was disconnected from url ${socket.conn.request.url} for the following reason: ${reason}
            ${JSON.stringify(details)}`
        );
        socket.removeAllListeners();
        socket.disconnect();
    });
  });
