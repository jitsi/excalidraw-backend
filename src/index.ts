import debug from 'debug';
import dotenv from 'dotenv';
import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';

// import * as prometheus from 'socket.io-prometheus-metrics';

const serverDebug = debug('server');

dotenv.config(
  process.env.NODE_ENV === 'development'
      ? { path: '.env.development' }
      : { path: '.env.production' }
);

const app = express();
const port = process.env.PORT || 80; // default port to listen
const users: Socket[] = [];
const userLimit = Number(process.env.USER_LIMIT) || Infinity;

app.get('/', (req, res) => {
    res.send('Excalidraw backend is up :)');
});

const server = http.createServer(app);

server.listen(port, () => {
    serverDebug(`listening on port: ${port}`);
});

const io = new Server(server, {
    cors: {
        origin: [ 'https://meet.jit.si', 'http://localhost:3002/' ],
        methods: [ 'GET', 'POST' ], // not sure about this
        allowedHeaders: 'Content-Type,Authorization',
        credentials: true
    },
    maxHttpBufferSize: 20e6,
    pingTimeout: 60000
});


// listens on host:9090/metrics
console.log('Rooms before initializing metrics:', io.sockets.adapter.rooms);

// eslint-disable-next-line max-len
// Currently its failing - TypeError: Cannot convert undefined or null to object - socket.io-prometheus-metrics/dist/index.js:154:16
// prometheus.metrics(io, {
//     collectDefaultMetrics: true
// });

io.on('connection', (socket: Socket) => {
    serverDebug(`connection established! ${socket.conn.request.url}`);
    io.to(`${socket.id}`).emit('init-room');
    socket.on('join-room', (roomID: string) => {
        serverDebug(`${socket.id} has joined ${roomID} for url ${socket.conn.request.url}`);
        socket.join(roomID);

        users.push(socket);
        socket.on('close', () => {
            users.splice(users.indexOf(socket), 1);
        });

        // const clients = Object.keys(io.sockets.adapter.rooms[roomID].sockets);
        const clientApadpter = io.sockets.adapter.rooms.get(roomID);
        const clients = Array.from(clientApadpter || []);


        if (clients.length > userLimit) {
            clients.forEach((clientKey: string) => {
                const clientSocket = io.sockets.sockets.get(clientKey);

                if (clientSocket !== undefined) {
                    serverDebug(`${clientSocket} has left the ${roomID} room because the user limit was reached.`);
                    clientSocket.leave(roomID);
                }
            });

            return;
        }

        if (clientApadpter !== undefined && clientApadpter.size <= 1) {
            io.to(`${socket.id}`).emit('first-in-room');
        } else {
            socket.broadcast.to(roomID).emit('new-user', socket.id);
        }
        io.in(roomID).emit(
            'room-user-change',
            clients
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
            const clientAdapter = rooms.get(roomID);

            const clients = Array.from(clientAdapter || []).filter(id => id !== socket.id);

            // clients = Object.keys(rooms[roomID].sockets).filter(id => id !== socket.id);

            if (roomID !== socket.id) {
                socket.to(roomID).emit('user has left', socket.id);
            }

            if (clients.length > 0) {
                socket.broadcast.to(roomID).emit('room-user-change', clients);
            }
        }
    });

    socket.on('disconnect', (reason, details) => {
        serverDebug(
            `${socket.id} was disconnected from url ${socket.conn.request.url} for the following reason: ${reason}
            ${JSON.stringify(details)}`
        );
        socket.removeAllListeners();
    });
});
