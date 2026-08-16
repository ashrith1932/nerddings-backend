import type { Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

import jwt from "jsonwebtoken";
import { and, eq, isNull, or } from "drizzle-orm";

import { env } from "../config/env.js";
import { db } from "../db/client.js";
import {
  conversationMembers,
  conversations,
  messageRequests,
  messages,
} from "../db/schema.js";

const require = createRequire(import.meta.url);

type RawData = Buffer | ArrayBuffer | Buffer[];

type WebSocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(
    event: "message",
    listener: (raw: RawData) => void | Promise<void>,
  ): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
};

type WebSocketServerLike = {
  on(
    event: "connection",
    listener: (socket: WebSocketLike) => void,
  ): void;
};

const { WebSocketServer, WebSocket } = require("ws") as {
  WebSocketServer: new (options: {
    server: HttpServer;
    path?: string;
  }) => WebSocketServerLike;
  WebSocket: { OPEN: number };
};

type AuthPayload = {
  sub?: string;
  accountType?: "user" | "agent";
};

type ClientMessage =
  | { type: "auth"; token: string }
  | {
      type: "message.send";
      clientMessageId: string;
      recipientId: string;
      ciphertext: string;
      iv: string;
      senderKey: string;
      recipientKey: string;
      encryptionVersion: number;
    }
  | { type: "message.delivered"; messageId: string }
  | { type: "message.read"; messageId: string }
  | { type: "conversation.read"; conversationId: string }
  | { type: "ping" };

const clients = new Map<string, Set<WebSocketLike>>();

function send(socket: WebSocketLike, payload: unknown) {
  if (socket.readyState !== WebSocket.OPEN) return false;

  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function addClient(userId: string, socket: WebSocketLike) {
  let sockets = clients.get(userId);

  if (!sockets) {
    sockets = new Set();
    clients.set(userId, sockets);
  }

  sockets.add(socket);
  console.log(
    `[WS] User ${userId} connected (${sockets.size} socket${sockets.size === 1 ? "" : "s"})`,
  );
}

function removeClient(userId: string, socket: WebSocketLike) {
  const sockets = clients.get(userId);
  if (!sockets) return;

  sockets.delete(socket);

  if (sockets.size === 0) {
    clients.delete(userId);
  }

  console.log(
    `[WS] User ${userId} disconnected (${sockets.size} socket${sockets.size === 1 ? "" : "s"})`,
  );
}

function sendToUser(userId: string, payload: unknown) {
  const sockets = clients.get(userId);

  if (!sockets || sockets.size === 0) {
    console.log(`[WS] User ${userId} is offline; event not pushed`);
    return 0;
  }

  let sent = 0;
  for (const socket of sockets) {
    if (send(socket, payload)) sent += 1;
  }

  console.log(`[WS] Pushed event to ${userId}: ${sent}/${sockets.size} socket(s)`);
  return sent;
}

function authenticate(token: string) {
  try {
    const payload = jwt.verify(token, env.AUTH_SECRET) as AuthPayload;

    if (
      !payload.sub ||
      (payload.accountType !== "user" && payload.accountType !== "agent")
    ) {
      return null;
    }

    return {
      userId: payload.sub,
      accountType: payload.accountType,
    };
  } catch {
    return null;
  }
}

async function findConversation(userA: string, userB: string) {
  if (!db) return null;

  const memberships = await db
    .select({ conversationId: conversationMembers.conversationId })
    .from(conversationMembers)
    .where(eq(conversationMembers.userId, userA));

  for (const membership of memberships) {
    const [match] = await db
      .select({ conversationId: conversationMembers.conversationId })
      .from(conversationMembers)
      .where(
        and(
          eq(
            conversationMembers.conversationId,
            membership.conversationId,
          ),
          eq(conversationMembers.userId, userB),
        ),
      )
      .limit(1);

    if (match) return match.conversationId;
  }

  return null;
}

async function createConversation(userA: string, userB: string) {
  if (!db) {
    throw new Error("Database is required for realtime messaging.");
  }

  const conversationId = randomUUID();

  await db.insert(conversations).values({ id: conversationId });

  await db.insert(conversationMembers).values([
    { conversationId, userId: userA },
    { conversationId, userId: userB },
  ]);

  return conversationId;
}

async function canMessage(userA: string, userB: string) {
  if (!db) return false;

  const [request] = await db
    .select()
    .from(messageRequests)
    .where(
      and(
        or(
          and(
            eq(messageRequests.senderId, userA),
            eq(messageRequests.recipientId, userB),
          ),
          and(
            eq(messageRequests.senderId, userB),
            eq(messageRequests.recipientId, userA),
          ),
        ),
        eq(messageRequests.status, "accepted"),
      ),
    )
    .limit(1);

  return Boolean(request);
}

function serializeMessage(message: typeof messages.$inferSelect) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    ciphertext: message.ciphertext,
    iv: message.iv,
    senderKey: message.senderKey,
    recipientKey: message.recipientKey,
    encryptionVersion: message.encryptionVersion,
    deliveredAt: message.deliveredAt?.toISOString() ?? null,
    readAt: message.readAt?.toISOString() ?? null,
    createdAt: message.createdAt.toISOString(),
  };
}

async function replayUndelivered(userId: string, socket: WebSocketLike) {
  if (!db) return;

  const rows = await db
    .select({
      message: messages,
    })
    .from(messages)
    .innerJoin(
      conversationMembers,
      eq(
        conversationMembers.conversationId,
        messages.conversationId,
      ),
    )
    .where(
      and(
        eq(conversationMembers.userId, userId),
        isNull(messages.deliveredAt),
      ),
    );

  let count = 0;

  for (const row of rows) {
    if (row.message.senderId === userId) continue;

    if (
      send(socket, {
        type: "message.new",
        message: serializeMessage(row.message),
        replay: true,
      })
    ) {
      count += 1;
    }
  }

  if (count > 0) {
    console.log(`[WS] Replayed ${count} undelivered message(s) to ${userId}`);
  }
}

export function attachRealtimeServer(server: HttpServer) {
  const wss = new WebSocketServer({
    server,
    path: "/api/v1/messages/ws",
  });

  wss.on("connection", (socket: WebSocketLike) => {
    let authenticatedUserId: string | null = null;

    socket.on("message", async (raw: RawData) => {
      try {
        const message = JSON.parse(raw.toString()) as ClientMessage;

        if (message.type === "ping") {
          send(socket, { type: "pong", timestamp: Date.now() });
          return;
        }

        if (message.type === "auth") {
          const auth = authenticate(message.token);

          if (!auth) {
            send(socket, {
              type: "auth.error",
              error: "Invalid authentication token.",
            });
            socket.close(1008, "Unauthorized");
            return;
          }

          if (authenticatedUserId) {
            removeClient(authenticatedUserId, socket);
          }

          authenticatedUserId = auth.userId;
          addClient(auth.userId, socket);

          send(socket, {
            type: "auth.success",
            userId: auth.userId,
          });

          // Replay messages that arrived while this browser was disconnected.
          void replayUndelivered(auth.userId, socket);

          return;
        }

        if (!authenticatedUserId) {
          send(socket, {
            type: "error",
            error: "Authenticate the WebSocket first.",
          });
          return;
        }

        if (message.type === "message.send") {
          if (!db) {
            send(socket, {
              type: "message.failed",
              clientMessageId: message.clientMessageId,
              error: "Database is unavailable.",
            });
            return;
          }

          const allowed = await canMessage(
            authenticatedUserId,
            message.recipientId,
          );

          if (!allowed) {
            send(socket, {
              type: "message.failed",
              clientMessageId: message.clientMessageId,
              error: "Messaging is not accepted.",
            });
            return;
          }

          const conversationId =
            (await findConversation(
              authenticatedUserId,
              message.recipientId,
            )) ??
            (await createConversation(
              authenticatedUserId,
              message.recipientId,
            ));

          const [created] = await db
            .insert(messages)
            .values({
              conversationId,
              senderId: authenticatedUserId,
              body: "",
              ciphertext: message.ciphertext,
              iv: message.iv,
              senderKey: message.senderKey,
              recipientKey: message.recipientKey,
              encryptionVersion: message.encryptionVersion,
            })
            .returning();

          await db
            .update(conversations)
            .set({ updatedAt: new Date() })
            .where(eq(conversations.id, conversationId));

          const outgoing = serializeMessage(created);

          // Server accepted and persisted the message.
          send(socket, {
            type: "message.sent",
            clientMessageId: message.clientMessageId,
            message: outgoing,
          });

          // Realtime delivery. If recipient is offline, the DB row remains
          // undelivered and replayUndelivered() will pick it up later.
          sendToUser(message.recipientId, {
            type: "message.new",
            message: outgoing,
          });

          return;
        }

        if (message.type === "message.delivered") {
          if (!db) return;

          const [stored] = await db
            .select()
            .from(messages)
            .where(eq(messages.id, message.messageId))
            .limit(1);

          if (!stored || stored.senderId === authenticatedUserId) return;

          const [membership] = await db
            .select()
            .from(conversationMembers)
            .where(
              and(
                eq(
                  conversationMembers.conversationId,
                  stored.conversationId,
                ),
                eq(
                  conversationMembers.userId,
                  authenticatedUserId,
                ),
              ),
            )
            .limit(1);

          if (!membership) return;

          const deliveredAt = new Date();

          await db
            .update(messages)
            .set({ deliveredAt })
            .where(eq(messages.id, stored.id));

          sendToUser(stored.senderId, {
            type: "message.delivered",
            messageId: stored.id,
            deliveredAt: deliveredAt.toISOString(),
          });

          return;
        }

        if (message.type === "message.read") {
          if (!db) return;

          const [stored] = await db
            .select()
            .from(messages)
            .where(eq(messages.id, message.messageId))
            .limit(1);

          if (!stored || stored.senderId === authenticatedUserId) return;

          const [membership] = await db
            .select()
            .from(conversationMembers)
            .where(
              and(
                eq(
                  conversationMembers.conversationId,
                  stored.conversationId,
                ),
                eq(
                  conversationMembers.userId,
                  authenticatedUserId,
                ),
              ),
            )
            .limit(1);

          if (!membership) return;

          const readAt = new Date();

          await db
            .update(messages)
            .set({
              deliveredAt: stored.deliveredAt ?? readAt,
              readAt,
            })
            .where(eq(messages.id, stored.id));

          sendToUser(stored.senderId, {
            type: "message.read",
            messageId: stored.id,
            readAt: readAt.toISOString(),
          });

          return;
        }

        if (message.type === "conversation.read") {
          if (!db) return;

          const [membership] = await db
            .select()
            .from(conversationMembers)
            .where(
              and(
                eq(
                  conversationMembers.conversationId,
                  message.conversationId,
                ),
                eq(
                  conversationMembers.userId,
                  authenticatedUserId,
                ),
              ),
            )
            .limit(1);

          if (!membership) return;

          const unread = await db
            .select()
            .from(messages)
            .where(
              and(
                eq(
                  messages.conversationId,
                  message.conversationId,
                ),
                isNull(messages.readAt),
              ),
            );

          const now = new Date();

          for (const stored of unread) {
            if (stored.senderId === authenticatedUserId) continue;

            await db
              .update(messages)
              .set({
                deliveredAt: stored.deliveredAt ?? now,
                readAt: now,
              })
              .where(eq(messages.id, stored.id));

            sendToUser(stored.senderId, {
              type: "message.read",
              messageId: stored.id,
              readAt: now.toISOString(),
            });
          }

          return;
        }
      } catch (error) {
        console.error("[WS] message error", error);

        send(socket, {
          type: "error",
          error: "Invalid realtime message.",
        });
      }
    });

    socket.on("close", () => {
      if (authenticatedUserId) {
        removeClient(authenticatedUserId, socket);
      }
    });

    socket.on("error", (error) => {
      console.error("[WS] socket error", error);
    });
  });

  console.log("[WS] Realtime messaging server attached.");
  return wss;
}
