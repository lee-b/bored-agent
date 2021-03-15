import WebSocket from "ws";
import { Server } from "yamux-js";
import type { Duplex } from "stream";
import * as tls from "tls";
import * as fs from "fs";
import { createDecipheriv, createCipheriv } from "crypto";
import { KeyPair } from "./keypair-manager";
import { StreamParser } from "./stream-parser";
import { StreamImpersonator } from "./stream-impersonator";

export type AgentProxyOptions = {
  boredServer: string;
  boredToken: string;
  idpPublicKey: string;
};

const caCert = process.env.CA_CERT || "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
const serviceAccountTokenPath = process.env.SERVICEACCOUNT_TOKEN_PATH || "/var/run/secrets/kubernetes.io/serviceaccount/token";

export class AgentProxy {
  private boredServer: string;
  private boredToken: string;
  private idpPublicKey: string;
  private cipherAlgorithm = "aes-256-gcm";
  private yamuxServer?: Server;
  private ws?: WebSocket;
  private caCert?: Buffer;
  private tlsSession?: Buffer;
  private keys?: KeyPair;
  private retryTimeout?: NodeJS.Timeout;
  private serviceAccountToken?: Buffer;

  constructor(opts: AgentProxyOptions) {
    this.boredServer = opts.boredServer;
    this.boredToken = opts.boredToken;
    this.idpPublicKey = opts.idpPublicKey;

    if (fs.existsSync(caCert)) {
      this.caCert = fs.readFileSync(caCert);
    }

    if (fs.existsSync(serviceAccountTokenPath)) {
      this.serviceAccountToken = fs.readFileSync(serviceAccountTokenPath);
    }
  }

  init(keys: KeyPair) {
    this.keys = keys;
  }

  connect(reconnect = false) {
    if (!reconnect) console.log(`PROXY: establishing reverse tunnel to ${this.boredServer} ...`);

    this.ws = new WebSocket(`${this.boredServer}/agent/connect`, {
      headers: {
        "Authorization": `Bearer ${this.boredToken}`,
        "X-BoreD-PublicKey": Buffer.from(this.keys?.public || "").toString("base64")
      }
    });
    this.ws.on("open", () => {
      if (!this.ws) return;

      console.log("PROXY: tunnel connection opened");
      this.yamuxServer = new Server(this.handleRequestStream.bind(this), {
        enableKeepAlive: false
      });

      this.yamuxServer.on("error", (error) => {
        console.error("YAMUX: server error", error);
      });

      const wsDuplex = WebSocket.createWebSocketStream(this.ws);

      this.yamuxServer.pipe(wsDuplex).pipe(this.yamuxServer);
    });

    const retry = () => {
      if (this.retryTimeout) clearTimeout(this.retryTimeout);
      this.retryTimeout = setTimeout(() => {
        this.connect(true);
      }, 1000);
    };

    this.ws.on("error", (err) => {
      console.error("PROXY: websocket error", err);
      retry();
    });
    this.ws.on("unexpected-response", () => {
      retry();
    });
    this.ws.on("close", (code: number) => {
      console.log(`PROXY: tunnel connection closed (code: ${code})`);
      retry();
    });
  }

  handleRequestStream(stream: Duplex) {
    const opts: tls.ConnectionOptions = {
      host: process.env.KUBERNETES_HOST || "kubernetes.default.svc",
      port: parseInt(process.env.KUBERNETES_SERVICE_PORT || "443"),
    };

    if (this.caCert) {
      opts.ca = this.caCert;
    } else {
      opts.rejectUnauthorized = false;

      opts.checkServerIdentity = () => {
        return undefined;
      };
    }

    if (this.tlsSession) {
      opts.session = this.tlsSession;
    }

    const socket = tls.connect(opts, () => {
      const parser = new StreamParser();

      parser.bodyParser = (key: Buffer, iv: Buffer) => {
        const decipher = createDecipheriv(this.cipherAlgorithm, key, iv);
        const cipher = createCipheriv(this.cipherAlgorithm, key, iv);

        socket.on("end", () => {
          //stream.end();
        });

        if (this.serviceAccountToken && this.idpPublicKey !== "") {
          const streamImpersonator = new StreamImpersonator();

          streamImpersonator.publicKey = this.idpPublicKey;
          streamImpersonator.saToken = this.serviceAccountToken.toString();
          parser.pipe(decipher).pipe(streamImpersonator).pipe(socket).pipe(cipher).pipe(stream);
        } else {
          parser.pipe(decipher).pipe(socket).pipe(cipher).pipe(stream);
        }
      };

      parser.privateKey = this.keys?.private || "";

      stream.pipe(parser);
    });

    socket.on("end", () => {
      stream.end();
    });

    socket.on("session", (session) => {
      this.tlsSession = session;
    });

    stream.on("end", () => {
      console.log("request ended");
      socket.end();
    });
  }

  disconnect() {
    this.ws?.close();
  }
}
