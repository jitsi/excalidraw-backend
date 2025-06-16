/*
 * Copyright 2023 UNIwise
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import express from 'express';
import * as http from 'http';
import * as prom from 'prom-client';
import * as io from 'socket.io';

const port = process.env.PROMETHEUS_PORT || 9090;


export interface IMetricsOptions {
    checkForNewNamespaces?: boolean;
    collectDefaultMetrics?: boolean;
    createServer?: boolean;
    path?: string;
    port?: number | string;
}

export interface IMetrics {
    bytesReceived: prom.Counter;
    bytesTransmitted: prom.Counter;
    connectTotal: prom.Counter;
    connectedSockets: prom.Gauge;
    disconnectTotal: prom.Counter;
    errorsTotal: prom.Counter;
    eventsReceivedTotal: prom.Counter;
    eventsSentTotal: prom.Counter;
}

/**
 * Shuts down the Express HTTP server exposing the metrics.
 *
 * @returns {Promise<void>}
 */
export class SocketIOMetrics {
    public register: prom.Registry;
    public metrics!: IMetrics;

    private ioServer: io.Server;
    private express!: express.Express;
    private expressServer!: http.Server;

    private options: IMetricsOptions;

    private boundNamespaces = new Set();

    private defaultOptions: IMetricsOptions = {
        port,
        path: '/metrics',
        createServer: true,
        collectDefaultMetrics: false,
        checkForNewNamespaces: true
    };

    /**
     * Constructs a new instance of the SocketIOMetrics class.
     * @param {io.Server} ioServer - The Socket.IO server instance to monitor.
     * @param {IMetricsOptions} [options] - Optional configuration for metrics setup.
     */
    constructor(ioServer: io.Server, options?: IMetricsOptions) {
        this.options = { ...this.defaultOptions,
            ...options };
        this.ioServer = ioServer;
        this.register = prom.register;

        this.initMetrics();
        this.bindMetrics();

        if (this.options.collectDefaultMetrics) {
            prom.collectDefaultMetrics({
                register: this.register
            });
        }

        if (this.options.createServer) {
            this.start();
        }
    }

    /*
    * Metrics Server
    */

    /**
     * Starts the server if it is not already running.
     *
     * @returns {void}
     */
    public start() {
        if (!this.expressServer || !this.expressServer.listening) {
            this.initServer();
        }
    }

    /**
     * Closes the express server.
     * @returns {Promise<void>} A promise that resolves when the server has been closed.
     */
    public async close() {
        return this.expressServer.close();
    }

    /**
     * Initializes the Express server and sets up a route for serving Prometheus metrics.
     * @returns {void}
     */
    private initServer() {
        this.express = express();
        this.expressServer = this.express.listen(this.options.port);
        const path = this.options.path || '/metrics';

        this.express.get(path, async (_req: express.Request, res: express.Response) => {
            res.set('Content-Type', this.register.contentType);
            const metricsResult = await this.register.metrics();

            res.end(metricsResult);
        });
    }

    /*
    * Metrics logic
    */


    /**
     * Initializes Prometheus metrics for Socket.IO monitoring.
     * @returns {void}
     */
    private initMetrics() {
        this.metrics = {
            connectedSockets: new prom.Gauge({
                name: 'socket_io_connected',
                help: 'Number of currently connected sockets'
            }),

            connectTotal: new prom.Counter({
                name: 'socket_io_connect_total',
                help: 'Total count of socket.io connection requests',
                labelNames: [ 'namespace' ]
            }),

            disconnectTotal: new prom.Counter({
                name: 'socket_io_disconnect_total',
                help: 'Total count of socket.io disconnections',
                labelNames: [ 'namespace' ]
            }),

            eventsReceivedTotal: new prom.Counter({
                name: 'socket_io_events_received_total',
                help: 'Total count of socket.io received events',
                labelNames: [ 'event', 'namespace' ]
            }),

            eventsSentTotal: new prom.Counter({
                name: 'socket_io_events_sent_total',
                help: 'Total count of socket.io sent events',
                labelNames: [ 'event', 'namespace' ]
            }),

            bytesReceived: new prom.Counter({
                name: 'socket_io_receive_bytes',
                help: 'Total socket.io bytes received',
                labelNames: [ 'event', 'namespace' ]
            }),

            bytesTransmitted: new prom.Counter({
                name: 'socket_io_transmit_bytes',
                help: 'Total socket.io bytes transmitted',
                labelNames: [ 'event', 'namespace' ]
            }),

            errorsTotal: new prom.Counter({
                name: 'socket_io_errors_total',
                help: 'Total socket.io errors',
                labelNames: [ 'namespace' ]
            })
        };
    }

    /**
     * Binds Prometheus metrics to the provided server's event emitter.
     * @param {io.Namespace} server - The event emitter to bind metrics to.
     * @param {Record<string, string>} labels - A record of labels to associate with the metrics.
     * @returns {void}
     */
    private bindMetricsOnEmitter(server: io.Namespace, labels: Record<string, string>): void {
        const blacklistedEvents = new Set([
            'error',
            'connect',
            'disconnect',
            'disconnecting',
            'newListener',
            'removeListener'
        ]);

        server.on('connect', (socket: any) => {
            // Connect events
            this.metrics.connectTotal.inc(labels);
            this.metrics.connectedSockets.set(this.ioServer.engine.clientsCount);

            // Disconnect events
            socket.on('disconnect', () => {
                this.metrics.disconnectTotal.inc(labels);
                this.metrics.connectedSockets.set(this.ioServer.engine.clientsCount);
            });

            // Hook into emit (outgoing event)
            const orgEmit = socket.emit;

            socket.emit = (event: string, ...data: any[]) => {
                if (!blacklistedEvents.has(event)) {
                    const labelsWithEvent = { event,
                        ...labels };

                    this.metrics.bytesTransmitted.inc(labelsWithEvent, this.dataToByteLength(data));
                    this.metrics.eventsSentTotal.inc(labelsWithEvent);
                }

                return orgEmit.apply(socket, [ event, ...data ]);
            };

            // Hook into onevent (incoming event)
            const orgOnEvent = socket.onevent;

            socket.onevent = (packet: any) => {
                if (packet?.data) {
                    const [ event, data ] = packet.data;

                    if (event === 'error') {
                        this.metrics.connectedSockets.set(this.ioServer.engine.clientsCount);
                        this.metrics.errorsTotal.inc(labels);
                    } else if (!blacklistedEvents.has(event)) {
                        const labelsWithEvent = { event,
                            ...labels };

                        this.metrics.bytesReceived.inc(labelsWithEvent, this.dataToByteLength(data));
                        this.metrics.eventsReceivedTotal.inc(labelsWithEvent);
                    }
                }

                return orgOnEvent.call(socket, packet);
            };
        });
    }


    /**
     * Binds metrics to a specific namespace within the server if not already bound.
     * @param {io.Server} server - The Socket.IO server instance.
     * @param {string} namespace - The namespace string to bind metrics to.
     * @returns {void}
     */
    private bindNamespaceMetrics(server: io.Server, namespace: string) {
        if (this.boundNamespaces.has(namespace)) {
            return;
        }
        const namespaceServer = server.of(namespace);

        this.bindMetricsOnEmitter(namespaceServer, { namespace });
        this.boundNamespaces.add(namespace);
    }

    /**
     * Binds metrics to all existing namespaces in the ioServer
     * and optionally checks for new namespaces at regular intervals.
     * @returns {void}
     */
    private bindMetrics() {
        Object.keys(this.ioServer._nsps).forEach(nsp =>
            this.bindNamespaceMetrics(this.ioServer, nsp)
        );

        if (this.options.checkForNewNamespaces) {
            setInterval(() => {
                Object.keys(this.ioServer._nsps).forEach(nsp =>
                    this.bindNamespaceMetrics(this.ioServer, nsp)
                );
            }, 2000);
        }
    }

    /*
    * Helping methods
    */

    /**
     * Calculates the byte length of the given data in UTF-8 encoding.
     * @param {any} data - The input data to calculate the byte length for. Can be a string or any serializable object.
     * @returns {number} The byte length of the input data in UTF-8 encoding, or 0 if an error occurs.
     */
    private dataToByteLength(data: any) {
        try {
            return Buffer.byteLength(typeof data === 'string' ? data : JSON.stringify(data) || '', 'utf8');
        } catch (e) {
            return 0;
        }
    }
}


/**
 * Creates a metrics collector for Socket.IO server.
 * @param {io.Server} ioServer - The Socket.IO server instance to monitor.
 * @param {IMetricsOptions} [options] - Optional for metrics collection.
 * @returns {SocketIOMetrics} A new SocketIOMetrics instance.
 */
export function metrics(ioServer: io.Server, options?: IMetricsOptions) {
    return new SocketIOMetrics(ioServer, options);
}
