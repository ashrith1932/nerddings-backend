import type { Server as HttpServer } from "node:http";
import jwt from "jsonwebtoken";
import WebSocket, {
  WebSocketServer,
  type RawData,
} from "ws";

import type { WebSocket as WebSocketType } from "ws";
import { env } from "../config/env.js";
import { db } from "../db/client.js";
import {
  conversationMembers,
  conversations,
  messageRequests,
  messages,
} from "../db/schema.js";
import { and, eq, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";

type AuthPayload = {
  sub?: string;
  accountType?: "user" | "agent";
};

type ClientMessage =
  | {
      type: "auth";
      token: string;
    }
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
  | {
      type: "ping";
    };

type AuthenticatedSocket = WebSocketType & {
  __nerddingUserId?: string;
};

const clients = new Map<
  string,
  Set<WebSocketType>
>();

function send(
  socket: WebSocketType,
  payload: unknown,
) {
  if (
    socket.readyState ===
    WebSocket.OPEN
  ) {
    socket.send(
      JSON.stringify(payload),
    );
  }
}

function addClient(
  userId: string,
  socket: WebSocketType,
) {
  let sockets =
    clients.get(userId);

  if (!sockets) {
    sockets =
      new Set<WebSocketType>();

    clients.set(
      userId,
      sockets,
    );
  }

  sockets.add(socket);
}

function removeClient(
  userId: string,
  socket: WebSocketType,
) {
  const sockets =
    clients.get(userId);

  if (!sockets) {
    return;
  }

  sockets.delete(socket);

  if (
    sockets.size === 0
  ) {
    clients.delete(userId);
  }
}

function sendToUser(
  userId: string,
  payload: unknown,
) {
  const sockets =
    clients.get(userId);

  if (!sockets) {
    return;
  }

  for (const socket of sockets) {
    send(
      socket,
      payload,
    );
  }
}

async function findConversation(
  userA: string,
  userB: string,
) {
  if (!db) {
    return null;
  }

  const memberships =
    await db
      .select({
        conversationId:
          conversationMembers.conversationId,
      })
      .from(
        conversationMembers,
      )
      .where(
        eq(
          conversationMembers.userId,
          userA,
        ),
      );

  for (
    const membership of memberships
  ) {
    const [match] =
      await db
        .select({
          conversationId:
            conversationMembers.conversationId,
        })
        .from(
          conversationMembers,
        )
        .where(
          and(
            eq(
              conversationMembers.conversationId,
              membership.conversationId,
            ),
            eq(
              conversationMembers.userId,
              userB,
            ),
          ),
        )
        .limit(1);

    if (match) {
      return match.conversationId;
    }
  }

  return null;
}

async function createConversation(
  userA: string,
  userB: string,
) {
  if (!db) {
    throw new Error(
      "Database is required for realtime messaging.",
    );
  }

  const conversationId =
    randomUUID();

  await db
    .insert(conversations)
    .values({
      id: conversationId,
    });

  await db
    .insert(
      conversationMembers,
    )
    .values([
      {
        conversationId,
        userId: userA,
      },
      {
        conversationId,
        userId: userB,
      },
    ]);

  return conversationId;
}

async function canMessage(
  userA: string,
  userB: string,
) {
  if (!db) {
    return false;
  }

  const [request] =
    await db
      .select()
      .from(
        messageRequests,
      )
      .where(
        and(
          or(
            and(
              eq(
                messageRequests.senderId,
                userA,
              ),
              eq(
                messageRequests.recipientId,
                userB,
              ),
            ),
            and(
              eq(
                messageRequests.senderId,
                userB,
              ),
              eq(
                messageRequests.recipientId,
                userA,
              ),
            ),
          ),
          eq(
            messageRequests.status,
            "accepted",
          ),
        ),
      )
      .limit(1);

  return Boolean(request);
}

function authenticate(
  token: string,
) {
  try {
    const payload =
      jwt.verify(
        token,
        env.AUTH_SECRET,
      ) as AuthPayload;

    if (
      !payload.sub ||
      (
        payload.accountType !==
          "user" &&
        payload.accountType !==
          "agent"
      )
    ) {
      return null;
    }

    return {
      userId:
        payload.sub,
      accountType:
        payload.accountType,
    };
  } catch {
    return null;
  }
}

export function attachRealtimeServer(
  server: HttpServer,
) {
  const wss =
  new WebSocketServer({
      server,
      path:
        "/api/v1/messages/ws",
    });

  wss.on(
    "connection",
    (
      socket: WebSocketType,
    ) => {
      let authenticatedUserId:
        | string
        | null = null;

      socket.on(
        "message",
        async (
          raw: RawData,
        ) => {
          try {
            const message =
              JSON.parse(
                raw.toString(),
              ) as ClientMessage;

            if (
              message.type ===
              "ping"
            ) {
              send(socket, {
                type:
                  "pong",
                timestamp:
                  Date.now(),
              });

              return;
            }

            if (
              message.type ===
              "auth"
            ) {
              const auth =
                authenticate(
                  message.token,
                );

              if (!auth) {
                send(socket, {
                  type:
                    "auth.error",
                  error:
                    "Invalid authentication token.",
                });

                socket.close(
                  1008,
                  "Unauthorized",
                );

                return;
              }

              authenticatedUserId =
                auth.userId;

              (
                socket as AuthenticatedSocket
              ).__nerddingUserId =
                auth.userId;

              addClient(
                auth.userId,
                socket,
              );

              send(socket, {
                type:
                  "auth.success",
                userId:
                  auth.userId,
              });

              return;
            }

            if (
              !authenticatedUserId
            ) {
              send(socket, {
                type:
                  "error",
                error:
                  "Authenticate the WebSocket first.",
              });

              return;
            }

            if (
              message.type ===
              "message.send"
            ) {
              if (!db) {
                send(socket, {
                  type:
                    "message.failed",
                  clientMessageId:
                    message.clientMessageId,
                  error:
                    "Database is unavailable.",
                });

                return;
              }

              const allowed =
                await canMessage(
                  authenticatedUserId,
                  message.recipientId,
                );

              if (!allowed) {
                send(socket, {
                  type:
                    "message.failed",
                  clientMessageId:
                    message.clientMessageId,
                  error:
                    "Messaging is not accepted.",
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

              const [
                created,
              ] = await db
                .insert(messages)
                .values({
                  conversationId,
                  senderId:
                    authenticatedUserId,
                  body: "",
                  ciphertext:
                    message.ciphertext,
                  iv:
                    message.iv,
                  senderKey:
                    message.senderKey,
                  recipientKey:
                    message.recipientKey,
                  encryptionVersion:
                    message.encryptionVersion,
                })
                .returning();

              await db
                .update(
                  conversations,
                )
                .set({
                  updatedAt:
                    new Date(),
                })
                .where(
                  eq(
                    conversations.id,
                    conversationId,
                  ),
                );

              const outgoing = {
                id:
                  created.id,
                conversationId,
                senderId:
                  authenticatedUserId,
                ciphertext:
                  created.ciphertext,
                iv:
                  created.iv,
                senderKey:
                  created.senderKey,
                recipientKey:
                  created.recipientKey,
                encryptionVersion:
                  created.encryptionVersion,
                createdAt:
                  created.createdAt.toISOString(),
              };

              send(socket, {
                type:
                  "message.sent",
                clientMessageId:
                  message.clientMessageId,
                message:
                  outgoing,
              });

              sendToUser(
                message.recipientId,
                {
                  type:
                    "message.new",
                  message:
                    outgoing,
                },
              );
            }
          } catch (error) {
            console.error(
              "[WS] message error",
              error,
            );

            send(socket, {
              type:
                "error",
              error:
                "Invalid realtime message.",
            });
          }
        },
      );

      socket.on(
        "close",
        () => {
          if (
            authenticatedUserId
          ) {
            removeClient(
              authenticatedUserId,
              socket,
            );
          }
        },
      );

      socket.on(
        "error",
        (
          error: Error,
        ) => {
          console.error(
            "[WS] socket error",
            error,
          );
        },
      );
    },
  );

  console.log(
    "[WS] Realtime messaging server attached.",
  );

  return wss;
}