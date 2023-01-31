import debug from 'debug';
import dotenv from 'dotenv';
import express from 'express';
import http from 'http';
import socketIO from 'socket.io';
import * as prometheus from 'socket.io-prometheus-metrics';

const serverDebug = debug('server');

dotenv.config(
  process.env.NODE_ENV === 'development'
      ? { path: '.env.development' }
      : { path: '.env.production' }
);

const app = express();
const port = process.env.PORT || 80; // default port to listen

app.get('/', (req, res) => {
    res.send('Excalidraw backend is up :)');
});

const server = http.createServer(app);

server.listen(port, () => {
    serverDebug(`listening on port: ${port}`);
});

const io = socketIO(server, {
    handlePreflightRequest: (req, res) => {
        const headers = {
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Allow-Origin': req.header?.origin ?? 'https://meet.jit.si',
            'Access-Control-Allow-Credentials': true
        };

        res.writeHead(200, headers);
        res.end();
    },
    perMessageDeflate: true
});

// listens on host:9090/metrics
prometheus.metrics(io, {
    collectDefaultMetrics: true
});

io.on('connection', socket => {
    serverDebug(`connection established! ${socket.conn.request.url}`);
    io.to(`${socket.id}`).emit('init-room');
    socket.on('join-room', roomID => {
        serverDebug(`${socket.id} has joined ${roomID} for url ${socket.conn.request.url}`);
        socket.join(roomID);
        if (io.sockets.adapter.rooms[roomID].length <= 1) {
            io.to(`${socket.id}`).emit('first-in-room');
        } else {
            socket.broadcast.to(roomID).emit('new-user', socket.id);
        }
        io.in(roomID).emit(
            'room-user-change',
            Object.keys(io.sockets.adapter.rooms[roomID].sockets)
        );
    });

    socket.on(
    'server-broadcast',
        (roomID: string, encryptedData: ArrayBuffer, iv: Uint8Array) => {
            socket.broadcast.to(roomID).emit('client-broadcast', encryptedData, iv);
        }
    );

    socket.on(
    'server-volatile-broadcast',
    (roomID: string, encryptedData: ArrayBuffer, iv: Uint8Array) => {
        socket.volatile.broadcast
        .to(roomID)
        .emit('client-broadcast', encryptedData, iv);
    }
    );

    socket.on('disconnecting', () => {
        const rooms = io.sockets.adapter.rooms;

        for (const roomID of Object.keys(socket.rooms)) {
            const clients = Object.keys(rooms[roomID].sockets).filter(id => id !== socket.id);

            if (roomID !== socket.id) {
                socket.to(roomID).emit('user has left', socket.id);
            }

            if (clients.length > 0) {
                socket.broadcast.to(roomID).emit('room-user-change', clients);
            }
        }
    });

    socket.on('disconnect', reason => {
        serverDebug(
            `${socket.id} was disconnected from url ${socket.conn.request.url} for the following reason: ${reason}`
        );
        socket.removeAllListeners();
    });
});
