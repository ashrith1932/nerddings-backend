declare module "ws" {
  import type { Server as HttpServer } from "node:http";

  export type RawData =
    | Buffer
    | ArrayBuffer
    | Buffer[];

  export class WebSocket {
    static readonly OPEN: number;

    readonly readyState: number;

    send(data: string): void;

    close(
      code?: number,
      reason?: string,
    ): void;

    on(
      event: "message",
      listener: (
        data: RawData,
      ) => void,
    ): this;

    on(
      event: "close",
      listener: () => void,
    ): this;

    on(
      event: "error",
      listener: (
        error: Error,
      ) => void,
    ): this;
  }

  export class WebSocketServer {
    constructor(options: {
      server: HttpServer;
      path?: string;
    });

    on(
      event: "connection",
      listener: (
        socket: WebSocket,
      ) => void,
    ): this;
  }
}