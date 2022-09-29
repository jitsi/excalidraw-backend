import debug from 'debug';
import dotenv from 'dotenv';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import * as prometheus from 'socket.io-prometheus-metrics';

const serverDebug = debug('server');
const ioDebug = debug('io');
const socketDebug = debug('socket');

dotenv.config(
  process.env.NODE_ENV === 'development'
      ? { path: '.env.development' }
      : { path: '.env.production' }
);

const app = express();
const port = process.env.PORT || 80; // default port to listen

app.use(express.static('public'));

app.get('/', (req, res) => {
    res.send('Excalidraw backend is up :)');
});

const server = http.createServer(app);

server.listen(port, () => {
    serverDebug(`listening on port: ${port}`);
});

const io = new Server(server);

// listens on host:9090/metrics
prometheus.metrics(io, {
    collectDefaultMetrics: true
});

io.on('connection', socket => {
    ioDebug('connection established!');
    io.to(`${socket.id}`).emit('init-room');
    socket.on('join-room', roomID => {
        socketDebug(`${socket.id} has joined ${roomID}`);
        socket.join(roomID);
        if (io.sockets.adapter.rooms.get(roomID)?.size ?? 0 <= 1) {
            io.to(`${socket.id}`).emit('first-in-room');
        } else {
            socket.broadcast.to(roomID).emit('new-user', socket.id);
        }
        io.in(roomID).emit('room-user-change', Array.from(io.sockets.adapter.rooms.get(roomID) ?? []));
    });

    socket.on(
    'server-broadcast',
    (roomID: string, encryptedData: ArrayBuffer, iv: Uint8Array) => {
        socketDebug(`${socket.id} sends update to ${roomID}`);
        socket.broadcast.to(roomID).emit('client-broadcast', encryptedData, iv);
    }
    );

    socket.on(
    'server-volatile-broadcast',
    (roomID: string, encryptedData: ArrayBuffer, iv: Uint8Array) => {
        socketDebug(`${socket.id} sends volatile update to ${roomID}`);
        socket.volatile.broadcast
        .to(roomID)
        .emit('client-broadcast', encryptedData, iv);
    }
    );

    socket.on('disconnecting', () => {
        const rooms = io.sockets.adapter.rooms;

        for (const roomID of Object.keys(socket.rooms)) {
            const clients = Array.from(rooms.get(roomID) ?? []).filter(id => id !== socket.id);

            if (clients.length > 0) {
                socket.broadcast.to(roomID).emit('room-user-change', clients);
            }
        }
    });

    socket.on('disconnect', () => {
        socket.removeAllListeners();
    });
});
