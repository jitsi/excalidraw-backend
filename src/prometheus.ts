import express from 'express';
import * as http from 'http';
import prom from 'prom-client';
import io from 'socket.io';

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
 * SocketIOMetrics.
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
        port: 9090,
        path: '/metrics',
        createServer: true,
        collectDefaultMetrics: false,
        checkForNewNamespaces: true
    };

    /**
 * Creates an instance of `SocketIOMetrics` to collect and expose metrics for a Socket.io server.
 *
 * @param {io.Server} ioServer - The Socket.io server instance.
 * @param {IMetricsOptions} [options] - Optional configuration for metrics collection.
 *
 *
 */
    constructor(ioServer: io.Server, options?: IMetricsOptions) {
        this.options = { ...this.defaultOptions,
            ...options };
        this.ioServer = ioServer;
        this.register = new prom.Registry();

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
    *
    * Metrics Server
    */

    /**
     * Start express server.
     *
     * @returns {void}
     */
    public start() {
        if (!this.expressServer || !this.expressServer.listening) {
            this.initServer();
        }
    }

    /**
     * Close our express server.
     *
     * @returns {void}
     */
    public async close() {
        return this.expressServer.close();
    }

    /** .
     * InitServer.
     *
     * @returns {void}
     */
    private initServer() {
        this.express = express();
        this.expressServer = this.express.listen(this.options.port);
        if (!this.options.path) {
            throw new Error('error while getting path');
        }
        this.express.get(this.options.path, async (_req: express.Request, res: express.Response) => {
            try {
                // eslint-disable-next-line @typescript-eslint/no-shadow
                const metrics = await this.register.metrics(); // Await the Promise

                res.set('Content-Type', this.register.contentType);
                res.end(metrics); // metrics is now a string
            } catch (error) {
                res.status(500).end('Error collecting metrics');
            }
        });
    }

    /*
    * Metrics logic
    */

    /**
     * InitMetrics.
     *
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
     * BindMetricsOnEmitter.
     *
     * @param {NodeJS.EventEmitterr} server - The Socket.io server instance.
     * @param {Record<string, string>} labels - Optional configuration for metrics collection.
     * @returns {void}
     */
    private bindMetricsOnEmitter(server: NodeJS.EventEmitter, labels: Record<string, string>) {
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

                    this.metrics.bytesTransmitted.inc(labelsWithEvent, this.dataToBytes(data));
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

                        this.metrics.bytesReceived.inc(labelsWithEvent, this.dataToBytes(data));
                        this.metrics.eventsReceivedTotal.inc(labelsWithEvent);
                    }
                }

                return orgOnEvent.call(socket, packet);
            };
        });
    }

    /**
     * BindNamespaceMetrics.
     *
     * @param {io.Server} server - The Socket.io server instance.
     * @param {string} namespace - Optional configuration for metrics collection.
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
     * BindNamespaceMetrics.
     *
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

    // eslint-disable-next-line require-jsdoc
    private dataToBytes(data: any) {
        try {
            return Buffer.byteLength(typeof data === 'string' ? data : JSON.stringify(data) || '', 'utf8');
        } catch (e) {
            return 0;
        }
    }
}

/**
     * Metrics.
     *
     * @param {io.Server} ioServer - The Socket.io server instance.
     * @param {IMetricsOptions} options - Optional configuration for metrics collection.
     * @returns {SocketIOMetrics}
    */
export function metrics(ioServer: io.Server, options?: IMetricsOptions) {
    return new SocketIOMetrics(ioServer, options);
}
